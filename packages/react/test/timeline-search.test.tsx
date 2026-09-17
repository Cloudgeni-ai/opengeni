import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { buildTimeline } from "../src/timeline/projection";
import { MessageTimeline } from "../src/components/message-timeline";
import {
  isTimelineSearchTarget,
  literalSearchOffset,
  matchAtOffset,
  searchMatchOffset,
  type TimelineSearchTarget,
} from "../src/components/timeline-search";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

function event(sequence: number, type: SessionEvent["type"], text: string): SessionEvent {
  return {
    id: `evt-${sequence}`,
    sequence,
    type,
    payload: { text },
    turnId: "turn-1",
    sessionId: "session-1",
    workspaceId: "ws-1",
    clientEventId: null,
    occurredAt: "2026-09-17T00:00:00.000Z",
  };
}

describe("exact timeline search", () => {
  test("raw offsets never highlight coincidentally matching unmarked rendered text", async () => {
    const previousCSS = globalThis.CSS;
    const previousHighlight = (globalThis as any).Highlight;
    let highlights = 0;
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: {
        highlights: {
          set: () => {
            highlights++;
          },
          delete: () => {},
        },
      },
    });
    (globalThis as any).Highlight = class extends Set<Range> {};
    try {
      const view = await renderComponent(
        <MessageTimeline
          events={[event(1, "user.message", "**a**testtest")]}
          searchTarget={{ sequence: 1, query: "test", offset: 5 }}
          renderMessageText={() => <p>atesttest</p>}
        />,
      );
      await flush(40);
      expect(highlights).toBe(0);
      await view.unmount();
    } finally {
      Object.defineProperty(globalThis, "CSS", { configurable: true, value: previousCSS });
      (globalThis as any).Highlight = previousHighlight;
    }
  });
  test("default Markdown renderer materializes the selected source occurrence", async () => {
    const text = "**a**testtest";
    const view = await renderComponent(
      <MessageTimeline
        events={[event(1, "user.message", text)]}
        searchTarget={{ sequence: 1, query: "test", offset: 5 }}
      />,
    );
    await flush(30);
    const mark = view.container.querySelector<HTMLElement>("[data-og-search-offset]");
    expect(mark?.dataset.ogSearchOffset).toBe("5");
    expect(mark?.textContent).toBe("test");
    expect(mark?.previousSibling?.textContent).toBe("**a**");
    expect(mark?.nextSibling?.textContent).toBe("test");
    await view.unmount();
  });
  test("matches literal metacharacters and repeated occurrences without offset arrays", () => {
    expect(literalSearchOffset("[a+b] then [A+B]", "[a+b]", 1)).toBe(11);
    expect(literalSearchOffset("İ before needle", "needle")).toBe(9);
    expect(literalSearchOffset("aaa", "aa", 1)).toBe(-1);
    expect(literalSearchOffset("x".repeat(2_000_000) + "END", "end")).toBe(2_000_000);
    expect(literalSearchOffset("test", "", 0)).toBe(-1);
    expect(literalSearchOffset("test", "test", -1)).toBe(-1);
  });

  test("explicit UTF-16 offsets resolve directly and stale offsets highlight nothing", () => {
    // "needle" appears twice; surrogate pairs shift UTF-16 offsets vs code points.
    const text = "𝔘 needle one needle two needle";
    const first = text.indexOf("needle");
    const second = text.indexOf("needle", first + 1);
    const third = text.lastIndexOf("needle");
    expect(second).not.toBe(first);
    expect(matchAtOffset(text, "needle", first)).toBe(first);
    expect(matchAtOffset(text, "NEEDLE", third)).toBe(third);
    // Off-by-one and past-the-end offsets are rejected instead of mis-highlighted.
    expect(matchAtOffset(text, "needle", first + 1)).toBe(-1);
    expect(matchAtOffset(text, "needle", text.length)).toBe(-1);
    expect(matchAtOffset(text, "needle", -1)).toBe(-1);
    expect(matchAtOffset(text, "needle", 1.5)).toBe(-1);
    expect(matchAtOffset(text, "", first)).toBe(-1);
    expect(matchAtOffset("😀", "😀", 1)).toBe(-1);
    // searchMatchOffset prefers a valid offset, otherwise falls back to the
    // occurrence ordinal exactly like before.
    expect(searchMatchOffset(text, { sequence: 1, query: "needle", offset: second })).toBe(second);
    expect(
      searchMatchOffset(text, { sequence: 1, query: "needle", offset: second, occurrence: 0 }),
    ).toBe(second);
    expect(searchMatchOffset(text, { sequence: 1, query: "needle", occurrence: 2 })).toBe(third);
    expect(searchMatchOffset(text, { sequence: 1, query: "needle", offset: first + 1 })).toBe(-1);
  });

  test("completed source identity survives a first-delta renderer id", () => {
    const items = buildTimeline([
      event(1, "user.message", "Question"),
      event(2, "agent.message.delta", "Answer"),
      event(3, "agent.message.completed", "Answer"),
    ]);
    const answer = items.find((item) => item.kind === "agent-message")!;
    expect(answer.id).toBe("evt-2");
    expect(isTimelineSearchTarget(answer, { sequence: 3, eventId: "evt-3", query: "answer" })).toBe(
      true,
    );
    expect(isTimelineSearchTarget(answer, { sequence: 3, eventId: "wrong", query: "answer" })).toBe(
      false,
    );
  });

  test("long user disclosures reveal and remain open after closing find", async () => {
    const events = [event(100, "user.message", "needle\n".repeat(50))];
    const searchTarget: TimelineSearchTarget = { sequence: 100, query: "needle", occurrence: 40 };
    const view = await renderComponent(<MessageTimeline events={events} autoFollow={false} />);
    await flush(20);
    expect(view.container.querySelector('[data-og-expanded="false"]')).not.toBeNull();
    await view.rerender(
      <MessageTimeline events={events} autoFollow={false} searchTarget={searchTarget} />,
    );
    await flush(30);
    expect(view.container.querySelector('[data-og-expanded="true"]')).not.toBeNull();
    const scroller = view.container.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
    scroller.scrollTop = 345;
    await view.rerender(<MessageTimeline events={events} autoFollow={false} searchTarget={null} />);
    await flush(30);
    expect(view.container.querySelector('[data-og-expanded="true"]')).not.toBeNull();
    expect(scroller.scrollTop).toBe(345);
    await view.unmount();
  });

  test("custom renderer receives only its own exact search target", async () => {
    const events = [event(100, "user.message", "needle"), event(101, "user.message", "other")];
    const targets = new Map<string, TimelineSearchTarget | null>();
    const searchTarget = { sequence: 100, query: "needle", occurrence: 0 };
    const view = await renderComponent(
      <MessageTimeline
        events={events}
        searchTarget={searchTarget}
        renderMessageText={(text, item, context) => {
          targets.set(item.id, context.searchTarget);
          return <p>{text}</p>;
        }}
      />,
    );
    expect(targets.get("evt-100")).toEqual(searchTarget);
    expect(targets.get("evt-101")).toBeNull();
    await view.unmount();
  });
});
