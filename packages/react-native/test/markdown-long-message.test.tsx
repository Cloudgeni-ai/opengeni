import { expect, mock, test } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import { registerDom, renderComponent } from "../../react/test/render-hook";

// The real react-native-markdown-display and markdown-it; only React Native's host
// views are stand-ins, so formatting is checked as the renderer really draws it.
type HostProps = { children?: ReactNode; style?: unknown };
function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === "object" ? (style as Record<string, unknown>) : {};
}
const host =
  (tag: string) =>
  ({ children, style }: HostProps) =>
    createElement(tag, { "data-style": JSON.stringify(flatten(style)) }, children);
mock.module("react-native", () => ({
  View: host("div"),
  Text: host("span"),
  ScrollView: host("div"),
  Image: host("img"),
  Pressable: host("button"),
  TouchableWithoutFeedback: host("span"),
  Linking: { openURL: () => Promise.resolve() },
  Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
  StyleSheet: {
    create: (styles: unknown) => styles,
    flatten,
    hairlineWidth: 1,
  },
}));
mock.module("react-native-fit-image", () => ({ default: host("img") }));
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
  DisplayMath: ({ tex }: { tex: string }) => createElement("math", { "data-display": tex }),
  InlineMath: ({ tex }: { tex: string }) => createElement("math", { "data-inline": tex }),
}));
mock.module("../src/timeline/interactive-answer", () => ({ NativeInteractiveAnswer: () => null }));
mock.module("../src/timeline/primitives", () => ({
  withAlpha: (color: string) => color,
  useReleaseFollow: () => () => {},
}));

registerDom();
// Frames run only when a test flushes them, so each frame's work can be observed.
const frames = new Map<number, () => void>();
let nextFrameId = 1;
globalThis.requestAnimationFrame = ((run: () => void) => {
  const id = nextFrameId++;
  frames.set(id, run);
  return id;
}) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) => {
  frames.delete(id);
}) as typeof cancelAnimationFrame;
const { createWebMarkdownRenderer } = await import("../src/timeline/markdown");
const { MAX_MARKDOWN_CHUNK_LENGTH } = await import("../src/timeline/markdown-limit");

type Block = { kind: string; content: string; state: string };
function renderer() {
  const blocks: Block[] = [];
  const render = createWebMarkdownRenderer({
    renderInteractiveBlock: (block) => {
      blocks.push(block);
      return createElement("og-preview", { "data-kind": block.kind, "data-state": block.state });
    },
  });
  return { blocks, render };
}

// The shape of the reported message: bold, bullets and a large inline visual.
const visual = [
  '<div id="ogm">',
  "<style>",
  ...Array.from(
    { length: 220 },
    (_, index) => `#ogm .row-${index}{color-scheme:light dark;--b:light-dark(#fff,#111);}`,
  ),
  "</style>",
  '<div class="bar">Frontier ← → Sovereign</div>',
  "</div>",
].join("\n");
const message = [
  "**Mockup.** It has three things to try:",
  "",
  "- **Headline:** pick one of three options with the buttons at the top.",
  "- **Sovereignty switch:** models that aren't available at the level you pick get dimmed.",
  "- **Model bar:** move your mouse left and right along it.",
  "",
  "```opengeni-html",
  visual,
  "```",
  "",
  "Read more in the [docs](https://example.com/docs). The score is $x^2$.",
].join("\n");

/** Runs one pending frame; false when none is pending. */
async function frame(): Promise<boolean> {
  const pending = [...frames.entries()];
  if (pending.length === 0) return false;
  frames.clear();
  await act(async () => {
    for (const [, run] of pending) run();
  });
  return true;
}

/** Runs frames until a long message is fully mounted; returns how many it took. */
async function settle(): Promise<number> {
  let count = 0;
  while (await frame()) {
    if (++count > 100) throw new Error("the message never finished mounting");
  }
  return count;
}

function strongTexts(container: Element): string[] {
  return Array.from(container.querySelectorAll("span"))
    .filter((span) => JSON.parse(span.getAttribute("data-style") ?? "{}").fontWeight === "600")
    .map((span) => span.textContent ?? "");
}

test("a long message renders its Markdown and its interactive preview", async () => {
  expect(message.length).toBeGreaterThan(MAX_MARKDOWN_CHUNK_LENGTH);
  const { blocks, render } = renderer();
  const view = await renderComponent(render(message, { tone: "body" }));
  await settle();
  const text = view.container.textContent ?? "";
  // Formatted, not source: no Markdown markers, no plain-text pager, no raw HTML or CSS.
  expect(text).not.toContain("**");
  expect(text).not.toContain("- **");
  expect(text).not.toContain("```");
  expect(text).not.toContain("<style>");
  expect(text).not.toContain("Plain text");
  expect(text).toContain("Mockup.");
  expect(strongTexts(view.container)).toEqual(
    expect.arrayContaining(["Mockup.", "Headline:", "Sovereignty switch:", "Model bar:"]),
  );
  // The bullets are list items (the drawn disc rows), not literal dashes.
  const discs = Array.from(view.container.querySelectorAll("div")).filter(
    (div) => JSON.parse(div.getAttribute("data-style") ?? "{}").borderRadius === 5.5 / 2,
  );
  expect(discs).toHaveLength(3);
  // The visual goes to the preview renderer whole, complete, and only once.
  expect(blocks).toEqual([{ kind: "html", content: visual, state: "complete" }]);
  expect(view.container.querySelectorAll("og-preview")).toHaveLength(1);
  // Links and math after the visual still render.
  expect(text).toContain("docs");
  expect(view.container.querySelector("math")?.getAttribute("data-inline")).toBe("x^2");
  await view.unmount();
});

test("a long message streaming its visual shows the loading state, then the preview", async () => {
  const { blocks, render } = renderer();
  const open = message.slice(0, message.indexOf("</div>\n```") + 6);
  const view = await renderComponent(render(open, { tone: "body", streaming: true }));
  await settle();
  expect(blocks.at(-1)).toEqual({ kind: "html", content: "", state: "streaming" });
  expect(view.container.textContent).not.toContain("<style>");
  await view.rerender(render(open, { tone: "body", streaming: false }));
  expect(blocks.at(-1)).toEqual({ kind: "html", content: "", state: "incomplete" });
  await view.rerender(render(message, { tone: "body" }));
  expect(blocks.at(-1)).toEqual({ kind: "html", content: visual, state: "complete" });
  await view.unmount();
});

test("a very long report renders formatted, one bounded slice per frame", async () => {
  const section = (index: number) =>
    `## Section ${index}\n\nSome **bold** text and a [link](https://example.com/${index}).\n\n` +
    "- one\n- two\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\n";
  let report = "";
  for (let index = 0; report.length < 60_000; index++) report += section(index);
  const { render } = renderer();
  const view = await renderComponent(render(report, { tone: "body" }));
  // The first commit draws about one chunk, not the whole report.
  const first = view.container.textContent ?? "";
  expect(first).toContain("Section 0");
  expect(first).not.toContain("Section 100");
  expect(first.length).toBeLessThan(MAX_MARKDOWN_CHUNK_LENGTH);
  // Then one more slice per frame, each at most one chunk.
  let previous = first.length;
  let count = 0;
  while (await frame()) {
    const now = (view.container.textContent ?? "").length;
    expect(now - previous).toBeLessThan(MAX_MARKDOWN_CHUNK_LENGTH);
    previous = now;
    count++;
  }
  expect(count).toBeGreaterThan(5);
  const text = view.container.textContent ?? "";
  expect(text).toContain(`Section ${report.split("## Section ").length - 2}`);
  expect(text).not.toContain("**");
  expect(text).not.toContain("## ");
  expect(text).not.toContain("Plain text");
  expect(text).toContain("const y = 2;");
  await view.unmount();
});
