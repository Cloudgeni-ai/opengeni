/* Which links in a react-native-markdown-display tree stand alone, the native
   counterpart of the web's rehype-standalone-links. The library wraps inline
   content in `textgroup` nodes and drops the paragraph inside list items, so a
   standalone link is the only link in a text group that is the only content of
   its paragraph or list item. */

export type MarkdownAstNode = {
  type: string;
  content?: string;
  children?: MarkdownAstNode[];
};

const LINK_CONTAINERS = new Set(["paragraph", "list_item"]);

function isBlankNode(node: MarkdownAstNode): boolean {
  return node.type === "softbreak" || (node.type === "text" && !(node.content ?? "").trim());
}

/**
 * Whether a text group holds a single link and is the only content of its
 * paragraph or list item. Whitespace does not count as content; anything else
 * (text, another link, emphasis, a hard break) does, as on the web.
 */
export function isStandaloneLinkGroup(
  group: MarkdownAstNode,
  container: MarkdownAstNode | undefined,
): boolean {
  if (group.type !== "textgroup" || !container || !LINK_CONTAINERS.has(container.type)) {
    return false;
  }
  const blocks = (container.children ?? []).filter((child) => !isBlankNode(child));
  if (blocks.length !== 1 || blocks[0] !== group) return false;
  const content = (group.children ?? []).filter((child) => !isBlankNode(child));
  return content.length === 1 && content[0]!.type === "link";
}
