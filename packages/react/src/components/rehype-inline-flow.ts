/* Flatten block structure into one inline run, for Markdown shown inside a
   heading, label or paragraph (question prompts, help text, option
   descriptions). Paragraphs, headings, list items, quotes and code blocks
   keep their inline content (links, emphasis, code) and are separated by a
   line break, or by a space when `separator` is "space". List items keep a
   bullet or number so a list still reads as one. Elements the inline
   renderer does not allow (images, task checkboxes) are dropped by its
   `allowedElements` afterwards.

   Structural hast types keep the module dependency-free, like stream-reveal. */

type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastChild[];
};
type HastText = { type: "text"; value: string };
type HastChild = HastElement | HastText | { type: string; value?: string; children?: HastChild[] };
type HastRoot = { children?: HastChild[] };

export type InlineFlowOptions = { separator?: "break" | "space" | undefined };

const BLOCKS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "div",
  "section",
]);

function isBlock(node: HastChild): node is HastElement {
  return node.type === "element" && BLOCKS.has((node as HastElement).tagName);
}

function isBlank(node: HastChild): boolean {
  return node.type === "text" && (node.value ?? "").trim() === "";
}

function text(value: string): HastText {
  return { type: "text", value };
}

export function rehypeInlineFlow(options: InlineFlowOptions = {}) {
  const separator = (): HastChild =>
    options.separator === "space"
      ? text(" ")
      : { type: "element", tagName: "br", properties: {}, children: [] };

  /** Inline runs of one child list, one run per block (inline siblings share a run). */
  function runs(children: HastChild[], listKind?: "ul" | "ol", start = 1): HastChild[][] {
    const hasBlock = children.some(isBlock);
    const result: HastChild[][] = [];
    let inline: HastChild[] = [];
    let item = start;
    const flushInline = () => {
      if (inline.some((node) => !isBlank(node))) result.push(inline);
      inline = [];
    };
    for (const child of children) {
      if (!isBlock(child)) {
        // Whitespace between blocks is source layout, not content.
        if (!(hasBlock && isBlank(child))) inline.push(child);
        continue;
      }
      flushInline();
      const nested =
        child.tagName === "ul" || child.tagName === "ol"
          ? runs(
              child.children,
              child.tagName,
              child.tagName === "ol" && typeof child.properties?.start === "number"
                ? child.properties.start
                : 1,
            )
          : runs(child.children);
      if (child.tagName === "li" && listKind) {
        const marker = listKind === "ol" ? `${item}. ` : "• ";
        item += 1;
        if (nested.length > 0) nested[0] = [text(marker), ...nested[0]!];
      }
      result.push(...nested);
    }
    flushInline();
    return result;
  }

  return (tree: HastRoot) => {
    const flowed: HastChild[] = [];
    for (const run of runs(tree.children ?? [])) {
      if (flowed.length > 0) flowed.push(separator());
      flowed.push(...run);
    }
    tree.children = flowed;
  };
}
