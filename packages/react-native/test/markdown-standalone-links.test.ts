import { describe, expect, test } from "bun:test";
import {
  isStandaloneLinkGroup,
  soleTextGroupOf,
  type MarkdownAstNode,
} from "../src/timeline/markdown-standalone-links";

// The renderer's own parse pipeline (without React Native), with the parser
// configured as the timeline configures it.
const parserPath = Bun.resolveSync(
  "react-native-markdown-display/src/lib/parser.js",
  import.meta.dir,
);
const { default: parser } = (await import(parserPath)) as {
  default: (
    source: string,
    render: (ast: MarkdownAstNode[]) => MarkdownAstNode[],
    markdownIt: unknown,
  ) => MarkdownAstNode[];
};
const markdownItPath = Bun.resolveSync("markdown-it", parserPath);
const { default: MarkdownIt } = (await import(markdownItPath)) as {
  default: (options: object) => unknown;
};
const markdownIt = MarkdownIt({ typographer: false, linkify: true });

/** Every link in the message, with whether it stands alone, as the renderer sees it. */
function links(source: string): Array<{ text: string; standalone: boolean }> {
  const tree = parser(source, (ast) => ast, markdownIt);
  const found: Array<{ text: string; standalone: boolean }> = [];
  const walk = (node: MarkdownAstNode, parents: MarkdownAstNode[]) => {
    if (node.type === "link") {
      const [group, container] = parents;
      found.push({
        text: (node.children ?? []).map((child) => child.content ?? "").join(""),
        standalone: group !== undefined && isStandaloneLinkGroup(group, container),
      });
    }
    for (const child of node.children ?? []) walk(child, [node, ...parents]);
  };
  for (const node of tree) walk(node, []);
  return found;
}

describe("standalone links in native Markdown", () => {
  test("a link alone in its paragraph stands alone", () => {
    expect(links("Here it is:\n\n[Order 42](app:order/42)\n\nDone.")).toEqual([
      { text: "Order 42", standalone: true },
    ]);
  });

  test("a link alone in a list item stands alone", () => {
    expect(links("- [Order 42](app:order/42)\n- [Order 43](app:order/43)")).toEqual([
      { text: "Order 42", standalone: true },
      { text: "Order 43", standalone: true },
    ]);
  });

  test("a link inside a sentence does not", () => {
    expect(links("Open [Order 42](app:order/42) to review it.")).toEqual([
      { text: "Order 42", standalone: false },
    ]);
  });

  test("two links in one paragraph, or a link with a label, do not", () => {
    expect(links("[A](app:a) [B](app:b)")).toEqual([
      { text: "A", standalone: false },
      { text: "B", standalone: false },
    ]);
    expect(links("- Order: [Order 42](app:order/42)")).toEqual([
      { text: "Order 42", standalone: false },
    ]);
  });

  test("emphasis around the link and hard breaks count as content", () => {
    expect(links("**[Order 42](app:order/42)**")).toEqual([
      { text: "Order 42", standalone: false },
    ]);
    expect(links("Before\\\n[Order 42](app:order/42)")).toEqual([
      { text: "Order 42", standalone: false },
    ]);
  });
});

/**
 * For each list item: whether its only content is a text group, and whether
 * that group is the one holding its standalone link (so the item drops its marker).
 */
function listItems(source: string): Array<{ sole: boolean; standaloneLink: boolean }> {
  const tree = parser(source, (ast) => ast, markdownIt);
  const found: Array<{ sole: boolean; standaloneLink: boolean }> = [];
  const standaloneGroups = new Set<MarkdownAstNode>();
  const collect = (node: MarkdownAstNode, parents: MarkdownAstNode[]) => {
    if (node.type === "link") {
      const [group, container] = parents;
      if (group && isStandaloneLinkGroup(group, container)) standaloneGroups.add(group);
    }
    for (const child of node.children ?? []) collect(child, [node, ...parents]);
  };
  const walk = (node: MarkdownAstNode) => {
    if (node.type === "list_item") {
      const group = soleTextGroupOf(node);
      found.push({
        sole: group !== undefined,
        standaloneLink: !!group && standaloneGroups.has(group),
      });
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of tree) collect(node, []);
  for (const node of tree) walk(node);
  return found;
}

describe("list items that hold only a standalone link", () => {
  test("tight and loose lists of lone links are found", () => {
    expect(listItems("- [Order 42](app:order/42)\n- [Order 43](app:order/43)")).toEqual([
      { sole: true, standaloneLink: true },
      { sole: true, standaloneLink: true },
    ]);
    expect(listItems("1. [Order 42](app:order/42)\n\n2. [Order 43](app:order/43)")).toEqual([
      { sole: true, standaloneLink: true },
      { sole: true, standaloneLink: true },
    ]);
  });

  test("items with other content keep their marker", () => {
    expect(listItems("- Order: [Order 42](app:order/42)\n- plain text")).toEqual([
      { sole: true, standaloneLink: false },
      { sole: true, standaloneLink: false },
    ]);
    expect(listItems("- [Order 42](app:order/42)\n\n  More about it.")).toEqual([
      { sole: false, standaloneLink: false },
    ]);
  });
});
