/* ----------------------------------------------------------------------------
   File tree virtualization (Files tab) — a dense tree mounts only a bounded row
   window (virtua), the lazy-expand + keyboard logic survives, and a cold residue
   dir offers "open when live" instead of dead children. Real DOM assertions
   (mounted `[role=treeitem]` counts), not proxy metrics.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { actRun, registerDom, renderComponent, flush } from "./render-hook";
import { FileBrowser } from "../src/components/file-browser";
import type { FileTreeNode, UseSandboxFilesResult } from "../src/hooks/use-sandbox-files";

registerDom();

function filesResult(
  tree: FileTreeNode[],
  overrides: Partial<UseSandboxFilesResult> = {},
): UseSandboxFilesResult {
  return {
    tree,
    expand: async () => {},
    expandingPaths: new Set<string>(),
    readFile: async () => ({
      path: "",
      encoding: "utf8",
      content: "",
      sizeBytes: 0,
      truncated: false,
      isBinary: false,
      revision: 0,
    }),
    writeFile: async () => ({ path: "", sizeBytes: 0, revision: 0 }),
    createFile: async () => {},
    createDir: async () => {},
    deleteEntry: async () => {},
    moveEntry: async () => {},
    refresh: async () => {},
    source: "live",
    capturedAt: null,
    loading: false,
    error: null,
    ...overrides,
  };
}

describe("FileBrowser virtualization", () => {
  test("the composite tree exposes its active descendant and complete boundary navigation", async () => {
    const tree: FileTreeNode[] = Array.from({ length: 20 }, (_, index) => ({
      path: `file-${String(index).padStart(2, "0")}.ts`,
      name: `file-${String(index).padStart(2, "0")}.ts`,
      kind: "file" as const,
    }));
    const r = await renderComponent(<FileBrowser result={filesResult(tree)} editable={false} />);
    await flush();
    const composite = r.container.querySelector('[role="tree"]') as HTMLDivElement;
    const press = async (key: string) => {
      await actRun(() =>
        composite.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
      );
      await flush();
    };
    const activeText = () => {
      const id = composite.getAttribute("aria-activedescendant");
      return id ? (r.container.querySelector(`[id="${id}"]`)?.textContent ?? "") : "";
    };

    await actRun(() => composite.focus());
    await flush();
    expect(activeText()).toContain("file-00.ts");
    const firstTreeItem = r.container.querySelector('[role="treeitem"]');
    expect(firstTreeItem?.getAttribute("aria-level")).toBe("1");
    expect(firstTreeItem?.getAttribute("aria-posinset")).toBe("1");
    expect(firstTreeItem?.getAttribute("aria-setsize")).toBe("20");
    expect(r.container.querySelectorAll('[role="treeitem"] button[tabindex="0"]')).toHaveLength(0);

    await press("End");
    expect(activeText()).toContain("file-19.ts");
    await press("Home");
    expect(activeText()).toContain("file-00.ts");
    await press("PageDown");
    expect(activeText()).toContain("file-09.ts");
    await press("PageUp");
    expect(activeText()).toContain("file-00.ts");
    await r.unmount();
  });

  test("the keyboard context menu owns focus, wraps with arrows, and returns focus on Escape", async () => {
    const tree: FileTreeNode[] = [{ path: "README.md", name: "README.md", kind: "file" as const }];
    const r = await renderComponent(<FileBrowser result={filesResult(tree)} />);
    await flush();
    const composite = r.container.querySelector('[role="tree"]') as HTMLDivElement;
    await actRun(() => composite.focus());
    await flush();
    await actRun(() =>
      composite.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true })),
    );
    await flush();

    const menu = r.container.querySelector('[role="menu"]') as HTMLDivElement;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(menu.getAttribute("aria-label")).toBe("Actions for README.md");
    expect(document.activeElement).toBe(items[0]!);
    await actRun(() =>
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })),
    );
    expect(document.activeElement).toBe(items.at(-1)!);
    await actRun(() =>
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await flush();
    expect(r.container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(composite);
    await r.unmount();
  });

  test("a 3000-node tree mounts a BOUNDED row window, not every node", async () => {
    const tree: FileTreeNode[] = Array.from({ length: 3000 }, (_, i) => ({
      path: `file-${i}.ts`,
      name: `file-${i}.ts`,
      kind: "file" as const,
    }));
    const r = await renderComponent(<FileBrowser result={filesResult(tree)} editable={false} />);
    await flush();
    const mounted = r.container.querySelectorAll('[role="treeitem"]').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100); // NOT 3000 — real virtualization
    await r.unmount();
  });

  test("a cold residue dir shows the 'open when live' row when expanded", async () => {
    // A collapsed residue dir from a capture: truncated, no children, source=capture.
    const tree: FileTreeNode[] = [
      { path: "node_modules", name: "node_modules", kind: "dir", truncated: true },
      { path: "index.ts", name: "index.ts", kind: "file" },
    ];
    const r = await renderComponent(
      <FileBrowser result={filesResult(tree, { source: "capture" })} editable={false} />,
    );
    await flush();
    // Expand the residue dir (its row is a button).
    const dirButton = Array.from(r.container.querySelectorAll('[role="treeitem"] button')).find(
      (b) => b.textContent?.includes("node_modules"),
    ) as HTMLButtonElement | undefined;
    expect(dirButton).toBeTruthy();
    await actRun(() => dirButton!.click());
    await flush();
    expect(r.container.textContent).toContain("contents on machine");
    await r.unmount();
  });

  test("a warm (live) truncated dir does NOT show the cold residue row", async () => {
    const tree: FileTreeNode[] = [
      { path: "node_modules", name: "node_modules", kind: "dir", truncated: true },
    ];
    const r = await renderComponent(
      <FileBrowser result={filesResult(tree, { source: "live" })} editable={false} />,
    );
    await flush();
    const dirButton = r.container.querySelector(
      '[role="treeitem"] button',
    ) as HTMLButtonElement | null;
    await actRun(() => dirButton?.click());
    await flush();
    expect(r.container.textContent).not.toContain("contents on machine");
    await r.unmount();
  });
});
