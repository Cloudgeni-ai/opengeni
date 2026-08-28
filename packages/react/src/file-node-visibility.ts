import type { FileTreeNode } from "./hooks/use-sandbox-files";

export type FileNodeVisibilityContext = {
  depth: number;
  parent: FileTreeNode | null;
};

/** Presentation-only predicate. It never changes filesystem authorization. */
export type FileNodeVisibilityPredicate = (
  node: FileTreeNode,
  context: FileNodeVisibilityContext,
) => boolean;

export type FilePathVisibility = "visible" | "hidden" | "unknown";

function pathIsInsideDirectory(path: string, directory: string): boolean {
  if (!path.startsWith(directory) || path === directory) return false;
  if (directory.endsWith("/") || directory.endsWith("\\")) return true;
  const boundary = path[directory.length];
  return boundary === "/" || boundary === "\\";
}

/**
 * Filter an authoritative tree without promoting children of a hidden parent.
 * Undefined children stay undefined so lazy-loading semantics are preserved.
 */
export function visibleFileTree(
  nodes: FileTreeNode[],
  predicate?: FileNodeVisibilityPredicate,
  parent: FileTreeNode | null = null,
  depth = 0,
): FileTreeNode[] {
  if (!predicate) return nodes;
  const visible: FileTreeNode[] = [];
  for (const node of nodes) {
    if (!predicate(node, { depth, parent })) continue;
    visible.push(
      node.children === undefined
        ? node
        : {
            ...node,
            children: visibleFileTree(node.children, predicate, node, depth + 1),
          },
    );
  }
  return visible;
}

/** Resolve only what the currently loaded tree can prove. */
export function filePathVisibility(
  nodes: FileTreeNode[],
  path: string,
  predicate?: FileNodeVisibilityPredicate,
  parent: FileTreeNode | null = null,
  depth = 0,
): FilePathVisibility {
  if (!predicate) return "visible";
  for (const node of nodes) {
    if (node.path !== path && !pathIsInsideDirectory(path, node.path)) continue;
    if (!predicate(node, { depth, parent })) return "hidden";
    if (node.path === path) return "visible";
    if (node.kind !== "dir" || node.children === undefined) return "unknown";
    return filePathVisibility(node.children, path, predicate, node, depth + 1);
  }
  return "unknown";
}
