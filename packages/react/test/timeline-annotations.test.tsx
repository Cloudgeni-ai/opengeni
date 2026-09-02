import { describe, expect, test } from "bun:test";
import type { DraftTimelineAnnotation } from "@opengeni/sdk";
import { act } from "react";
import { MessageTimeline } from "../src";
import { TimelineAnnotationsChip } from "../src/components/timeline-annotations";
import type { UserMessageItem } from "../src/timeline";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const SOURCE_EVENT_ID = "00000000-0000-4000-8000-000000000501";

function userItem(id: string, text: string, sequence: number): UserMessageItem {
  return {
    kind: "user-message",
    id,
    text,
    resources: [],
    tools: [],
    occurredAt: "2026-08-09T12:00:00.000Z",
    annotationSource: {
      kind: "user_message",
      eventId: id,
      eventType: "user.message",
      sequence,
      turnId: null,
      text,
    },
  };
}

function annotation(note = "Keep this exact constraint."): DraftTimelineAnnotation {
  return {
    id: "00000000-0000-4000-8000-000000000502",
    source: {
      kind: "assistant_message",
      eventId: SOURCE_EVENT_ID,
      eventType: "agent.message.completed",
      sequence: 4,
      turnId: "00000000-0000-4000-8000-000000000503",
      startOffset: 6,
      endOffset: 10,
      contextBefore: "alpha ",
      contextAfter: " omega",
    },
    quote: "beta",
    note,
  };
}

function selectText(node: Text, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  Object.defineProperty(range, "getBoundingClientRect", {
    value: () => ({
      left: 40,
      right: 90,
      top: 20,
      bottom: 40,
      width: 50,
      height: 20,
      x: 40,
      y: 20,
      toJSON: () => ({}),
    }),
  });
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function firstTextNode(element: Element): Text {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!(node instanceof Text)) throw new Error("expected timeline source text");
  return node;
}

async function waitForDomValue<T>(
  read: () => T | null | undefined,
  description: string,
): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    await flush(5);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe("timeline annotations", () => {
  test("turns one same-message text selection into one exact draft annotation", async () => {
    let captured: DraftTimelineAnnotation | null = null;
    const item = userItem(SOURCE_EVENT_ID, "alpha beta omega", 3);
    const rendered = await renderComponent(
      <MessageTimeline items={[item]} onAnnotate={(next) => (captured = next)} />,
    );
    await flush();
    const source = rendered.container.querySelector<HTMLElement>(
      `[data-og-annotation-source-key="${SOURCE_EVENT_ID}"]`,
    );
    expect(source).not.toBeNull();
    const text = firstTextNode(source!);
    selectText(text, 6, 10);
    source?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    const action = await waitForDomValue(
      () =>
        [...document.body.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Annotate",
        ),
      "the annotation selection action",
    );
    await act(async () => action.click());
    expect(captured).toMatchObject({
      quote: "beta",
      note: "",
      source: {
        eventId: SOURCE_EVENT_ID,
        startOffset: 6,
        endOffset: 10,
        contextBefore: "alpha ",
        contextAfter: " omega",
      },
    });
    await rendered.unmount();
  });

  test("rejects a selection spanning two timeline messages", async () => {
    const first = userItem("00000000-0000-4000-8000-000000000511", "first", 1);
    const second = userItem("00000000-0000-4000-8000-000000000512", "second", 2);
    const rendered = await renderComponent(
      <MessageTimeline items={[first, second]} onAnnotate={() => undefined} />,
    );
    await flush();
    const sources = rendered.container.querySelectorAll<HTMLElement>(
      "[data-og-annotation-source-key]",
    );
    const range = document.createRange();
    range.setStart(firstTextNode(sources[0]!), 0);
    range.setEnd(firstTextNode(sources[1]!), 3);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    sources[1]?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    await flush();
    expect(
      [...document.body.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Annotate",
      ),
    ).toBe(false);
    await rendered.unmount();
  });

  test("keeps one editable chip and exposes source-unavailable feedback", async () => {
    await import("../src/components/timeline-annotations-dialog");
    let note = "";
    const rendered = await renderComponent(
      <TimelineAnnotationsChip
        annotations={[annotation("")]}
        editable
        focusAnnotationId="00000000-0000-4000-8000-000000000502"
        onUpdate={(_id, next) => (note = next)}
        onRemove={() => undefined}
      />,
    );
    const trigger = rendered.container.querySelector("button");
    expect(trigger?.textContent).toContain("1 annotation");
    const textarea = await waitForDomValue(
      () => document.body.querySelector("textarea"),
      "the annotation note editor",
    );
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "Use the quoted value.");
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    expect(note).toBe("Use the quoted value.");
    const sourceButton = await waitForDomValue(
      () =>
        [...document.body.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("view source"),
        ),
      "the annotation source action",
    );
    await act(async () => sourceButton.click());
    await waitForDomValue(
      () =>
        document.body.textContent?.includes("Source is outside the loaded timeline window.")
          ? true
          : undefined,
      "source-unavailable feedback",
    );
    await rendered.unmount();
  });
});
