import { describe, expect, test } from "bun:test";
import type { DraftTimelineAnnotation } from "@opengeni/sdk";
import { act, useState } from "react";
import { MessageTimeline } from "../src";
import { TimelineAnnotationsChip } from "../src/components/timeline-annotations";
import type { AgentMessageItem, UserMessageItem } from "../src/timeline";
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

function agentItem(id: string, text: string, sequence: number): AgentMessageItem {
  return {
    kind: "agent-message",
    id,
    turnId: "00000000-0000-4000-8000-000000000504",
    text,
    streaming: false,
    occurredAt: "2026-08-09T12:00:00.000Z",
    annotationSource: {
      kind: "assistant_message",
      eventId: id,
      eventType: "agent.message.completed",
      sequence,
      turnId: "00000000-0000-4000-8000-000000000504",
      text,
    },
  };
}

function stubRangeGeometry(): void {
  const rect = {
    left: 40,
    right: 90,
    top: 20,
    bottom: 40,
    width: 50,
    height: 20,
    x: 40,
    y: 20,
    toJSON: () => ({}),
  };
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => {
      const list = {
        length: 1,
        item: () => rect,
        0: rect,
        [Symbol.iterator]: function* () {
          yield rect;
        },
      };
      return list;
    },
  });
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

function addNoteButton(): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.startsWith("Add a note about"),
  );
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await flush(10);
  }
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
    await waitFor(() => Boolean(addNoteButton()), "annotation action did not appear");
    const action = addNoteButton();
    expect(action).toBeDefined();
    expect(action?.textContent).toContain("Add note");
    expect(action?.textContent).toContain("beta");
    await act(async () => action?.click());
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
    expect(addNoteButton()).toBeUndefined();
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
    const textarea = document.body.querySelector("textarea");
    expect(textarea).not.toBeNull();
    await act(async () => {
      if (textarea) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(textarea, "Use the quoted value.");
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
    });
    expect(note).toBe("Use the quoted value.");
    const sourceButton = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("view source"),
    );
    await act(async () => sourceButton?.click());
    await waitFor(
      () =>
        document.body.textContent?.includes("Source is outside the loaded timeline window.") ===
        true,
      "source-unavailable feedback did not appear",
    );
    expect(document.body.textContent).toContain("Source is outside the loaded timeline window.");
    await rendered.unmount();
  });

  test("lets the focused chip close instead of staying pinned open", async () => {
    await import("../src/components/timeline-annotations-dialog");
    let consumed = 0;
    const rendered = await renderComponent(
      <TimelineAnnotationsChip
        annotations={[annotation("")]}
        editable
        focusAnnotationId="00000000-0000-4000-8000-000000000502"
        onFocusConsumed={() => {
          consumed += 1;
        }}
        onUpdate={() => undefined}
        onRemove={() => undefined}
      />,
    );
    expect(document.body.querySelector("textarea")).not.toBeNull();
    const close = [...document.body.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Close",
    );
    await act(async () => close?.click());
    await flush();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(consumed).toBeGreaterThan(0);
    await rendered.unmount();
  });

  test("keeps composer annotations as one numbered count chip", async () => {
    await import("../src/components/timeline-annotations-dialog");
    let note = "";
    const removed: string[] = [];
    const rendered = await renderComponent(
      <TimelineAnnotationsChip
        annotations={[annotation("")]}
        editable
        focusAnnotationId="00000000-0000-4000-8000-000000000502"
        onUpdate={(_id, next) => {
          note = next;
        }}
        onRemove={(id) => {
          removed.push(id);
        }}
      />,
    );
    const chip = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Review 1 annotation"]',
    );
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("1 annotation");
    expect(rendered.container.textContent).not.toContain("Quoted note");
    expect(rendered.container.textContent).not.toContain("Add a note to send this quote.");
    expect(rendered.container.querySelector("textarea")).toBeNull();
    const textarea = document.body.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.getAttribute("placeholder")).toBe("Add a note…");
    expect(document.activeElement).toBe(textarea);
    expect(document.body.textContent).toContain("Annotation 1");
    await act(async () => {
      if (textarea) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(textarea, "Keep this exact constraint.");
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
    });
    expect(note).toBe("Keep this exact constraint.");
    const remove = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove all annotations"]',
    );
    await act(async () => remove?.click());
    expect(removed).toEqual(["00000000-0000-4000-8000-000000000502"]);
    await rendered.unmount();
  });

  test("keeps one grouped composer chip until the review list is opened", async () => {
    await import("../src/components/timeline-annotations-dialog");
    const second: DraftTimelineAnnotation = {
      ...annotation(""),
      id: "00000000-0000-4000-8000-000000000522",
      quote: "gamma",
    };
    const rendered = await renderComponent(
      <TimelineAnnotationsChip
        annotations={[annotation("Keep this exact constraint."), second]}
        editable
        onUpdate={() => undefined}
        onRemove={() => undefined}
      />,
    );
    expect(rendered.container.textContent).toContain("2 annotations");
    expect(
      rendered.container.querySelector('button[aria-label="Review 2 annotations"]'),
    ).not.toBeNull();
    expect(document.body.querySelector("textarea")).toBeNull();
    await act(async () => {
      rendered.container
        .querySelector<HTMLButtonElement>('button[aria-label="Review 2 annotations"]')
        ?.click();
    });
    await waitFor(
      () => document.body.querySelector("textarea") !== null,
      "annotation review list did not open",
    );
    expect(document.body.textContent).toContain("Annotation 1");
    expect(document.body.textContent).toContain("Annotation 2");
    expect(document.body.querySelector("textarea")).not.toBeNull();
    await rendered.unmount();
  });

  test("commits a completed note with Enter and closes the review list with Escape", async () => {
    await import("../src/components/timeline-annotations-dialog");
    function Harness() {
      const [items, setItems] = useState([annotation("")]);
      return (
        <TimelineAnnotationsChip
          annotations={items}
          editable
          focusAnnotationId={items[0]?.id}
          onUpdate={(id, next) => {
            setItems((current) =>
              current.map((item) => (item.id === id ? { ...item, note: next } : item)),
            );
          }}
          onRemove={() => undefined}
        />
      );
    }
    const rendered = await renderComponent(<Harness />);
    const textarea = document.body.querySelector("textarea");
    expect(textarea).not.toBeNull();
    await act(async () => {
      if (textarea) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(textarea, "Keep this exact constraint.");
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
    });
    await act(async () => {
      textarea?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    await waitFor(
      () => document.body.querySelector('[role="dialog"]') === null,
      "Enter did not close the annotation review list",
    );
    await act(async () => {
      rendered.container
        .querySelector<HTMLButtonElement>('button[aria-label="Review 1 annotation"]')
        ?.click();
    });
    await waitFor(
      () => document.body.querySelector('[role="dialog"]') !== null,
      "annotation review list did not reopen",
    );
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(
      () => document.body.querySelector('[role="dialog"]') === null,
      "Escape did not close the annotation review list",
    );
    await rendered.unmount();
  });

  test("keeps a full sentence quote visible in the open review list", async () => {
    await import("../src/components/timeline-annotations-dialog");
    const rendered = await renderComponent(
      <TimelineAnnotationsChip
        annotations={[
          {
            ...annotation(""),
            quote: "OpenGeni stack is working.",
          },
        ]}
        editable
        focusAnnotationId="00000000-0000-4000-8000-000000000502"
        onUpdate={() => undefined}
        onRemove={() => undefined}
      />,
    );
    expect(rendered.container.textContent).toContain("1 annotation");
    expect(rendered.container.textContent).not.toContain("OpenGeni stack is working.");
    expect(document.body.textContent).toContain("OpenGeni stack is working.");
    expect(document.body.querySelector("textarea")).not.toBeNull();
    await rendered.unmount();
  });

  test("keeps the Add note popover through pointerdown so the click can land", async () => {
    const captured: DraftTimelineAnnotation[] = [];
    const item = userItem(SOURCE_EVENT_ID, "alpha beta omega", 3);
    const rendered = await renderComponent(
      <MessageTimeline items={[item]} onAnnotate={(next) => captured.push(next)} />,
    );
    await flush();
    const source = rendered.container.querySelector<HTMLElement>(
      `[data-og-annotation-source-key="${SOURCE_EVENT_ID}"]`,
    );
    const text = firstTextNode(source!);
    selectText(text, 6, 10);
    source?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    await waitFor(() => Boolean(addNoteButton()), "annotation action did not appear");
    const action = addNoteButton();
    action?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await flush();
    expect(addNoteButton()).toBeDefined();
    expect(addNoteButton()?.textContent).toContain("beta");
    await act(async () => action?.click());
    expect(captured[0]?.quote).toBe("beta");
    await rendered.unmount();
  });

  test("still offers Add note when pointerup lands outside the timeline", async () => {
    const item = userItem(SOURCE_EVENT_ID, "alpha beta omega", 3);
    const rendered = await renderComponent(
      <MessageTimeline items={[item]} onAnnotate={() => undefined} />,
    );
    await flush();
    const source = rendered.container.querySelector<HTMLElement>(
      `[data-og-annotation-source-key="${SOURCE_EVENT_ID}"]`,
    );
    source?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    selectText(firstTextNode(source!), 6, 10);
    document.body.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    await waitFor(
      () => Boolean(addNoteButton()),
      "annotation action did not appear after pointerup outside the timeline",
    );
    expect(addNoteButton()?.textContent).toContain("beta");
    await rendered.unmount();
  });

  test("does not resurrect a leftover selection from a click that started outside", async () => {
    const item = userItem(SOURCE_EVENT_ID, "alpha beta omega", 3);
    const rendered = await renderComponent(
      <MessageTimeline items={[item]} onAnnotate={() => undefined} />,
    );
    await flush();
    const source = rendered.container.querySelector<HTMLElement>(
      `[data-og-annotation-source-key="${SOURCE_EVENT_ID}"]`,
    );
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    selectText(firstTextNode(source!), 6, 10);
    source?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    await flush();
    expect(addNoteButton()).toBeUndefined();
    await rendered.unmount();
  });

  test("clips a chrome-inclusive highlight back to the assistant sentence", async () => {
    const captured: DraftTimelineAnnotation[] = [];
    const text = "OpenGeni stack is working.";
    const item = agentItem(SOURCE_EVENT_ID, text, 4);
    const rendered = await renderComponent(
      <MessageTimeline items={[item]} onAnnotate={(next) => captured.push(next)} />,
    );
    await flush();
    const source = rendered.container.querySelector<HTMLElement>(
      `[data-og-annotation-source-key="${SOURCE_EVENT_ID}"]`,
    );
    const chrome = rendered.container.querySelector<HTMLElement>("[data-og-annotation-chrome]");
    expect(source).not.toBeNull();
    expect(chrome).not.toBeNull();
    stubRangeGeometry();
    const range = document.createRange();
    range.setStart(firstTextNode(source!), 0);
    range.setEnd(chrome!, 0);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    source?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    await waitFor(() => Boolean(addNoteButton()), "annotation action did not appear for a long highlight");
    const action = addNoteButton();
    expect(action?.textContent).toContain("OpenGeni stack is working.");
    await act(async () => action?.click());
    expect(captured[0]?.quote).toBe(text);
    await rendered.unmount();
  });

  test("pins numbered badges on quoted timeline text", async () => {
    stubRangeGeometry();
    const item = userItem(SOURCE_EVENT_ID, "alpha beta omega", 3);
    const first = annotation("");
    const second: DraftTimelineAnnotation = {
      ...annotation("Keep this exact constraint."),
      id: "00000000-0000-4000-8000-000000000522",
      quote: "omega",
      source: {
        ...annotation().source,
        startOffset: 11,
        endOffset: 16,
        contextBefore: "beta ",
        contextAfter: "",
      },
    };
    const selected: string[] = [];
    const rendered = await renderComponent(
      <MessageTimeline
        items={[item]}
        onAnnotate={() => undefined}
        draftAnnotations={[first, second]}
        onDraftAnnotationSelect={(id) => selected.push(id)}
      />,
    );
    await flush();
    const badges = [...document.body.querySelectorAll<HTMLButtonElement>("[data-og-annotation-badge]")];
    expect(badges.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Annotation 1",
      "Annotation 2",
    ]);
    await act(async () => badges[1]?.click());
    expect(selected).toEqual(["00000000-0000-4000-8000-000000000522"]);
    await rendered.unmount();
  });
});
