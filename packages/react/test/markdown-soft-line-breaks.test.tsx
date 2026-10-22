import { describe, expect, test } from "bun:test";
import type { AgentMessageItem, UserMessageItem } from "../src";
import { Markdown } from "../src/components/markdown";
import { MessageTimeline } from "../src/components/message-timeline";
import { remarkSoftLineBreaks } from "../src/components/remark-soft-line-breaks";
import { registerDom, renderComponent } from "./render-hook";

registerDom();

async function render(
  source: string,
  props: { streaming?: boolean; softLineBreaks?: boolean } = {},
) {
  const r = await renderComponent(
    <Markdown softLineBreaks={props.softLineBreaks ?? true} streaming={props.streaming}>
      {source}
    </Markdown>,
  );
  return r;
}

describe("Markdown soft line breaks", () => {
  test("single newlines render as line breaks", async () => {
    const r = await render("1\n2\n3");
    const paragraphs = r.container.querySelectorAll("p");
    expect(paragraphs.length).toBe(1);
    expect(paragraphs[0]!.querySelectorAll("br").length).toBe(2);
    // Text content (search, copy-as-text, annotation offsets) keeps the newline.
    expect(paragraphs[0]!.textContent).toBe("1\n2\n3");
    await r.unmount();
  });

  test("is opt-in: without the prop a single newline stays CommonMark whitespace", async () => {
    const r = await render("1\n2\n3", { softLineBreaks: false });
    expect(r.container.querySelectorAll("br").length).toBe(0);
    expect(r.container.querySelector("p")!.textContent).toBe("1\n2\n3");
    await r.unmount();
  });

  test("a blank line still separates paragraphs", async () => {
    const r = await render("first\n\nsecond\nthird");
    const paragraphs = Array.from(r.container.querySelectorAll("p"));
    expect(paragraphs.map((p) => p.textContent)).toEqual(["first", "second\nthird"]);
    expect(paragraphs[0]!.querySelector("br")).toBeNull();
    expect(paragraphs[1]!.querySelectorAll("br").length).toBe(1);
    await r.unmount();
  });

  test("fenced and inline code keep their newlines without <br>", async () => {
    const r = await render("before\n```ts\nconst a = 1;\nconst b = 2;\n```\nuse `x` here\nnext");
    const pre = r.container.querySelector("pre")!;
    expect(pre.querySelector("br")).toBeNull();
    expect(pre.textContent).toContain("const a = 1;\nconst b = 2;");
    const inline = Array.from(r.container.querySelectorAll("code")).find(
      (code) => code.textContent === "x",
    );
    expect(inline).toBeDefined();
    // Paragraph after the fence: "use `x` here" / "next" split by one break.
    const paragraphs = Array.from(r.container.querySelectorAll("p"));
    expect(paragraphs.at(-1)!.querySelectorAll("br").length).toBe(1);
    await r.unmount();
  });

  test("lists, tables, blockquotes, and headings keep their structure", async () => {
    const source = [
      "# Title",
      "- one",
      "- two",
      "  continued",
      "",
      "1. first",
      "2. second",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "> quoted",
      "> still quoted",
    ].join("\n");
    const r = await render(source);
    expect(r.container.querySelector("h1")!.textContent).toBe("Title");
    expect(r.container.querySelector("h1")!.querySelector("br")).toBeNull();
    const bullets = Array.from(r.container.querySelectorAll("ul > li"));
    expect(bullets.length).toBe(2);
    expect(bullets[0]!.querySelector("br")).toBeNull();
    // A lazy continuation line inside an item is a soft break like any prose.
    expect(bullets[1]!.querySelectorAll("br").length).toBe(1);
    expect(bullets[1]!.textContent).toBe("two\ncontinued");
    expect(r.container.querySelectorAll("ol > li").length).toBe(2);
    expect(r.container.querySelectorAll("table tbody tr").length).toBe(1);
    expect(r.container.querySelector("table")!.querySelector("br")).toBeNull();
    const quote = r.container.querySelector("blockquote")!;
    expect(quote.querySelectorAll("p").length).toBe(1);
    expect(quote.querySelectorAll("br").length).toBe(1);
    expect(quote.textContent?.trim()).toBe("quoted\nstill quoted");
    await r.unmount();
  });

  test("existing hard breaks and inline formatting across lines are preserved", async () => {
    const r = await render("**bold**\n_em_  \ntail");
    const paragraph = r.container.querySelector("p")!;
    expect(paragraph.querySelectorAll("br").length).toBe(2);
    expect(paragraph.querySelector("strong")!.textContent).toBe("bold");
    expect(paragraph.querySelector("em")!.textContent).toBe("em");
    await r.unmount();
  });

  test("streaming: each arriving line gets a break and keeps tip ink", async () => {
    const r = await render("1\n", { streaming: true });
    expect(r.container.querySelectorAll("br").length).toBe(0);
    expect(r.container.textContent).toContain("1");
    await r.rerender(
      <Markdown softLineBreaks streaming>
        {"1\n2"}
      </Markdown>,
    );
    expect(r.container.querySelectorAll("br").length).toBe(1);
    await r.rerender(
      <Markdown softLineBreaks streaming>
        {"1\n2\n3 fresh words"}
      </Markdown>,
    );
    const paragraph = r.container.querySelector("p")!;
    expect(paragraph.querySelectorAll("br").length).toBe(2);
    expect(paragraph.textContent).toBe("1\n2\n3 fresh words");
    // Split lines keep source positions, so the newest line still fades in.
    const inked = Array.from(paragraph.querySelectorAll("span.og-stream-ink")).map(
      (span) => span.textContent,
    );
    expect(inked.join("")).toContain("fresh words");
    await r.unmount();
  });

  test("streaming: an unterminated fence keeps code newlines without breaks", async () => {
    const r = await render("intro\nmore\n```\nline one\nline two", { streaming: true });
    expect(r.container.querySelector("p")!.querySelectorAll("br").length).toBe(1);
    const pre = r.container.querySelector("pre")!;
    expect(pre.querySelector("br")).toBeNull();
    expect(pre.textContent).toContain("line one\nline two");
    await r.unmount();
  });
});

describe("remarkSoftLineBreaks positions", () => {
  test("re-anchors continuation lines on the real source line", () => {
    const source = "> a\n>   bc";
    const text = {
      type: "text",
      value: "a\nbc",
      position: {
        start: { line: 1, column: 3, offset: 2 },
        end: { line: 2, column: 7, offset: source.length },
      },
    };
    const tree = { type: "root", children: [{ type: "paragraph", children: [text] }] };
    remarkSoftLineBreaks()(tree, { value: source });
    const children = (tree.children[0] as { children: unknown[] }).children as {
      type: string;
      value?: string;
      position?: { start: { line: number; column: number; offset: number } };
    }[];
    expect(children.map((child) => child.type)).toEqual(["text", "break", "text"]);
    expect(children[0]!.position!.start.offset).toBe(2);
    expect(children[2]!.value).toBe("bc");
    expect(children[2]!.position!.start).toEqual({ line: 2, column: 5, offset: 8 });
    expect(source.slice(children[2]!.position!.start.offset)).toBe("bc");
  });
});

describe("MessageTimeline chat bodies", () => {
  test("agent and user messages render single newlines as line breaks", async () => {
    const agent: AgentMessageItem = {
      kind: "agent-message",
      id: "agent-1",
      text: "alpha\nbeta",
      streaming: false,
      occurredAt: "2026-01-01T00:00:00.000Z",
    } as AgentMessageItem;
    const user: UserMessageItem = {
      kind: "user-message",
      id: "user-1",
      text: "one\ntwo",
      resources: [],
      occurredAt: "2026-01-01T00:00:00.000Z",
    } as unknown as UserMessageItem;
    const r = await renderComponent(<MessageTimeline items={[user, agent]} />);
    const paragraphs = Array.from(r.container.querySelectorAll("p")).filter((p) =>
      ["alpha\nbeta", "one\ntwo"].includes(p.textContent ?? ""),
    );
    expect(paragraphs.length).toBe(2);
    for (const paragraph of paragraphs) {
      expect(paragraph.querySelectorAll("br").length).toBe(1);
    }
    await r.unmount();
  });
});
