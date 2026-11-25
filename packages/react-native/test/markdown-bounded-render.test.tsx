import { expect, mock, test } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import { registerDom, renderComponent } from "../../react/test/render-hook";
import {
  MAX_MARKDOWN_CHUNK_LENGTH,
  MAX_MARKDOWN_LENGTH,
  plainTextPage,
} from "../src/timeline/markdown-limit";

const markdownInputs: string[] = [];
const rendererPath = Bun.resolveSync(
  "react-native-markdown-display/src/lib/parser.js",
  import.meta.dir,
);
const parserPath = Bun.resolveSync("markdown-it", rendererPath);
const { default: MarkdownIt } = await import(parserPath);
mock.module("react-native-markdown-display", () => ({
  MarkdownIt,
  renderRules: {},
  default: ({ children }: { children: string }) => {
    markdownInputs.push(children);
    return createElement("div", { "data-markdown": true }, children);
  },
}));
const host =
  (tag: string) =>
  ({ children }: { children?: ReactNode }) =>
    createElement(tag, null, children);
mock.module("react-native", () => ({
  View: host("div"),
  Text: host("span"),
  ScrollView: host("div"),
  Image: host("img"),
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => createElement("button", { onClick: onPress, disabled }, children),
  Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
mock.module("react-native-svg", () => ({
  default: host("svg"),
  Defs: host("defs"),
  LinearGradient: host("linearGradient"),
  Rect: host("rect"),
  Stop: host("stop"),
  Path: host("path"),
  Circle: host("circle"),
  Line: host("line"),
  Polyline: host("polyline"),
}));
mock.module("../src/timeline/markdown-math", () => ({
  DisplayMath: () => null,
  InlineMath: () => null,
}));
mock.module("../src/timeline/interactive-answer", () => ({ NativeInteractiveAnswer: () => null }));
mock.module("../src/timeline/primitives", () => ({
  withAlpha: (color: string) => color,
  useReleaseFollow: () => () => {},
}));

registerDom();
const { createWebMarkdownRenderer } = await import("../src/timeline/markdown");
const render = createWebMarkdownRenderer();

test("the real renderer only sends bounded input to Markdown, including streaming growth", async () => {
  markdownInputs.length = 0;
  const view = await renderComponent(render("**hello**", { tone: "body", streaming: true }));
  expect(markdownInputs).toEqual(["**hello**"]);
  const text = "a://".repeat(MAX_MARKDOWN_LENGTH / 4) + "FINAL CHARACTER 😀";
  await view.rerender(render(text, { tone: "body", streaming: true }));
  expect(markdownInputs).toEqual(["**hello**"]);
  const pages: string[] = [];
  for (let index = 0; index < plainTextPage(text, 0).count; index++) {
    const spans = view.container.querySelectorAll("span");
    pages.push(spans[spans.length - 1]!.textContent ?? "");
    expect(pages[index]!.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHUNK_LENGTH);
    const next = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Next",
    )!;
    if (!next.disabled) await act(async () => next.click());
  }
  expect(pages.join("")).toBe(text);
  expect(markdownInputs).toEqual(["**hello**"]);
  const previous = Array.from(view.container.querySelectorAll("button")).find(
    (button) => button.textContent === "Previous",
  )!;
  await act(async () => previous.click());
  expect(view.container.textContent).toContain(pages[pages.length - 2]!);
  await view.rerender(render("Short again.", { tone: "body" }));
  expect(markdownInputs.at(-1)).toBe("Short again.");
  await view.unmount();
});

test("math-expanded input falls back to the original, fully readable source", async () => {
  markdownInputs.length = 0;
  const text = "$x$ ".repeat(MAX_MARKDOWN_CHUNK_LENGTH / 4);
  const view = await renderComponent(render(text, { tone: "muted" }));
  expect(markdownInputs).toEqual([]);
  expect(view.container.textContent).toContain(plainTextPage(text, 0).text);
  await view.unmount();
});

test("while a long message streams, only the chunk that changed is parsed again", async () => {
  const paragraphs = Array.from({ length: 900 }, (_, index) => `Paragraph **${index}**.`);
  const text = paragraphs.join("\n\n");
  expect(text.length).toBeGreaterThan(MAX_MARKDOWN_CHUNK_LENGTH);
  const view = await renderComponent(render(text, { tone: "body", streaming: true }));
  // Let every frame mount its slice.
  for (let frame = 0; frame < 20; frame++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  const chunks = [...markdownInputs];
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.every((chunk) => chunk.length <= MAX_MARKDOWN_CHUNK_LENGTH)).toBe(true);
  expect(view.container.textContent).toContain("Paragraph **899**.");
  markdownInputs.length = 0;
  await view.rerender(render(`${text} More`, { tone: "body", streaming: true }));
  await view.rerender(render(`${text} More words`, { tone: "body", streaming: true }));
  // Each delta re-parses the last chunk only.
  expect(markdownInputs).toHaveLength(2);
  expect(markdownInputs.every((chunk) => chunk.startsWith(chunks.at(-1)!))).toBe(true);
  await view.unmount();
});
