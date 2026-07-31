import { describe, expect, test } from "bun:test";
import { registerDom, renderComponent, flush } from "./render-hook";
import { createStreamReveal, INK_FADE_MS } from "../src/components/stream-reveal";
import { Markdown } from "../src/components/markdown";

registerDom();

describe("createStreamReveal", () => {
  test("appends share one birth; age window fades the whole batch together", () => {
    const reveal = createStreamReveal();
    reveal.observe("hello world", 1000);
    // Same append → same delay (no per-word stagger).
    const first = reveal.delayFor(0, 1000);
    const last = reveal.delayFor(6, 1000);
    expect(first).not.toBeNull();
    expect(last).toBe(first);

    // A later append animates only the new suffix.
    reveal.observe("hello world and beyond", 2000);
    expect(reveal.delayFor(12, 2000)).not.toBeNull();

    // First batch is settled once its age window has passed.
    expect(reveal.delayFor(0, 2000)).toBeNull();
    expect(reveal.hasActive(2000)).toBe(true);
    expect(reveal.hasActive(2000 + INK_FADE_MS)).toBe(false);
  });

  test("a mid-fade re-render resumes with a negative delay, never restarts", () => {
    const reveal = createStreamReveal();
    reveal.observe("word", 1000);
    const delay = reveal.delayFor(0, 1100);
    expect(delay).not.toBeNull();
    expect(delay!).toBeLessThan(0);
    expect(delay!).toBeGreaterThan(-INK_FADE_MS);
  });

  test("a large first observation is history, not tip ink — renders instantly", () => {
    const reveal = createStreamReveal();
    reveal.observe("x".repeat(2000), 1000);
    expect(reveal.delayFor(0, 1000)).toBeNull();
    expect(reveal.hasActive(1000)).toBe(false);
    reveal.observe(`${"x".repeat(2000)} fresh words`, 1500);
    expect(reveal.delayFor(2001, 1500)).not.toBeNull();
  });

  test("re-observing the same text is idempotent (StrictMode double render)", () => {
    const reveal = createStreamReveal();
    reveal.observe("hello", 1000);
    const before = reveal.delayFor(0, 1000);
    reveal.observe("hello", 1000);
    expect(reveal.delayFor(0, 1000)).toBe(before!);
  });

  test("fast multi-batch tip keeps a longer young band than a single old batch", () => {
    const reveal = createStreamReveal();
    // Three quick appends — all still inside the age window at t=1300.
    reveal.observe("aaa", 1000);
    reveal.observe("aaabbb", 1100);
    reveal.observe("aaabbbccc", 1200);
    expect(reveal.delayFor(0, 1300)).not.toBeNull();
    expect(reveal.delayFor(3, 1300)).not.toBeNull();
    expect(reveal.delayFor(6, 1300)).not.toBeNull();
    // Older batch further along (more negative delay) than the tip.
    expect(reveal.delayFor(0, 1300)!).toBeLessThan(reveal.delayFor(6, 1300)!);
  });
});

describe("Markdown streaming tip ink", () => {
  test("a burst renders as continuous .og-stream-ink (not per-word stagger)", async () => {
    const r = await renderComponent(<Markdown streaming>x</Markdown>);
    await r.rerender(<Markdown streaming>x brave new world</Markdown>);

    const spans = Array.from(r.container.querySelectorAll("span.og-stream-ink"));
    expect(spans.length).toBeGreaterThanOrEqual(1);
    const suffixSpans = spans.filter((span) => (span.textContent ?? "").includes("brave"));
    expect(suffixSpans.length).toBeGreaterThanOrEqual(1);
    // One append birth → one delay for the whole young suffix (markdown may
    // still split text nodes; delays stay identical).
    const delays = suffixSpans.map((span) => (span as HTMLElement).style.animationDelay);
    expect(new Set(delays).size).toBe(1);
    expect(delays[0]).toMatch(/^-?\d+ms$/);
    expect(suffixSpans.map((span) => span.textContent).join("")).toContain("brave");
    // Not one span per word with escalating delays.
    expect(spans.filter((span) => span.textContent === "brave").length).toBeLessThanOrEqual(1);

    expect(r.container.textContent).toContain("x brave new world");
    await r.unmount();
  });

  test("code content is never wrapped", async () => {
    const r = await renderComponent(<Markdown streaming>{"run `bun test` now"}</Markdown>);
    const code = r.container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.querySelector(".og-stream-ink")).toBeNull();
    expect(code!.textContent).toBe("bun test");
    await r.unmount();
  });

  test("after streaming ends, the body unwinds to plain markdown", async () => {
    const r = await renderComponent(<Markdown streaming>hello world</Markdown>);
    expect(r.container.querySelector(".og-stream-ink")).not.toBeNull();
    await r.rerender(<Markdown streaming={false}>hello world</Markdown>);
    await flush(1000);
    expect(r.container.querySelector(".og-stream-ink")).toBeNull();
    expect(r.container.textContent).toContain("hello world");
    await r.unmount();
  });

  test("non-streaming bodies never carry ink spans", async () => {
    const r = await renderComponent(<Markdown>hello world</Markdown>);
    expect(r.container.querySelector(".og-stream-ink")).toBeNull();
    await r.unmount();
  });

  test("stream end crystallizes when the reveal pipeline tears down", async () => {
    const r = await renderComponent(<Markdown streaming>**bold** text</Markdown>);
    expect(r.container.querySelector(".og-markdown-settle")).toBeNull();
    await r.rerender(<Markdown streaming={false}>**bold** text</Markdown>);
    expect(r.container.querySelector(".og-markdown-settle")).toBeNull();
    await flush(950);
    expect(r.container.querySelector(".og-markdown-settle")).not.toBeNull();
    await flush(600);
    expect(r.container.querySelector(".og-markdown-settle")).toBeNull();
    await r.unmount();
  });
});
