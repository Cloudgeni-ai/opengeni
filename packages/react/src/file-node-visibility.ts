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

/**
 * Tool, dependency and cache folders, wherever they are: they belong to the
 * tools, not the work, so the Files view leaves them out until the person
 * shows hidden files.
 */
const TOOL_AND_CACHE_DIRS = new Set([
  ".bun",
  ".cache",
  ".git",
  ".gradle",
  ".mypy_cache",
  ".npm",
  ".pnpm-store",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".turbo",
  ".venv",
  ".yarn",
  "__pycache__",
  "node_modules",
]);

/**
 * Whether the Files view leaves an entry out by default, behind its Show
 * hidden toggle: tool and cache folders anywhere, and every hidden (dot)
 * entry at the top of a workspace that isn't itself a repository (the
 * sandbox's home, where tools keep `.bun`, `.config` and the like). Inside a
 * repository its own dotfiles (`.github`, `.env.example`) stay in view.
 * Presentation only: nothing is removed or made unreachable.
 */
export function isHiddenByDefault(
  node: FileTreeNode,
  context: FileNodeVisibilityContext,
  rootIsRepository: boolean,
): boolean {
  if (node.kind === "dir" && TOOL_AND_CACHE_DIRS.has(node.name)) return true;
  return context.depth === 0 && !rootIsRepository && node.name.startsWith(".");
}

/** Whether the tree's top is a repository's own root (it holds `.git`). */
export function treeRootIsRepository(nodes: readonly FileTreeNode[]): boolean {
  return nodes.some((node) => node.name === ".git");
}

/**
 * Whether a path may lie under an entry the Files view hides by default,
 * judged from its name alone (for a path whose folders aren't loaded yet).
 * Errs towards yes: it only decides whether to show hidden files.
 */
export function pathMayBeHiddenByDefault(path: string): boolean {
  return path
    .split(/[/\\]/u)
    .some((segment) => segment.startsWith(".") || TOOL_AND_CACHE_DIRS.has(segment));
}

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
