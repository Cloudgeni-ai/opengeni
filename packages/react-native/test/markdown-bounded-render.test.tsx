import { expect, mock, test } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import { registerDom, renderComponent } from "../../react/test/render-hook";
import { MAX_MARKDOWN_LENGTH, plainTextPage } from "../src/timeline/markdown-limit";

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
  const text = "a://".repeat(10_000) + "FINAL CHARACTER 😀";
  await view.rerender(render(text, { tone: "body", streaming: true }));
  expect(markdownInputs).toEqual(["**hello**"]);
  const pages: string[] = [];
  for (let index = 0; index < plainTextPage(text, 0).count; index++) {
    const spans = view.container.querySelectorAll("span");
    pages.push(spans[spans.length - 1]!.textContent ?? "");
    expect(pages[index]!.length).toBeLessThanOrEqual(MAX_MARKDOWN_LENGTH);
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
  const text = "$x$ ".repeat(MAX_MARKDOWN_LENGTH / 4);
  const view = await renderComponent(render(text, { tone: "muted" }));
  expect(markdownInputs).toEqual([]);
  expect(view.container.textContent).toContain(plainTextPage(text, 0).text);
  await view.unmount();
});
