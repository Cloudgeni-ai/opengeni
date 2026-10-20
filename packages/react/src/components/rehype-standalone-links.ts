/* Mark a link that is the only content of its paragraph or list item with
   `data-og-standalone`, so a host link renderer can draw it as a block (a card
   or preview) instead of inline text. Whitespace around the link does not
   count as content; anything else (text, another link, emphasis) does.

   Structural hast types keep the module dependency-free, like stream-reveal. */

type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastChild[];
};
type HastChild = HastElement | { type: string; value?: string; children?: HastChild[] };
type HastParent = { children?: HastChild[] };

export const STANDALONE_LINK_PROPERTY = "dataOgStandalone";
export const STANDALONE_LINK_ATTRIBUTE = "data-og-standalone";

const CONTAINERS = new Set(["p", "li"]);

function isElement(node: HastChild): node is HastElement {
  return node.type === "element";
}

function isBlank(node: HastChild): boolean {
  return node.type === "text" && (node.value ?? "").trim() === "";
}

/** The single link a paragraph or list item holds, ignoring whitespace. */
export function standaloneLinkOf(container: { children?: HastChild[] }): HastElement | null {
  const content = (container.children ?? []).filter((child) => !isBlank(child));
  const only = content.length === 1 ? content[0] : undefined;
  return only && isElement(only) && only.tagName === "a" ? only : null;
}

export function rehypeStandaloneLinks() {
  return (tree: HastParent) => {
    walk(tree);
  };

  function walk(node: HastParent): void {
    for (const child of node.children ?? []) {
      if (!isElement(child)) continue;
      if (CONTAINERS.has(child.tagName)) {
        const link = standaloneLinkOf(child);
        if (link) link.properties = { ...link.properties, [STANDALONE_LINK_PROPERTY]: "" };
      }
      walk(child);
    }
  }
}
