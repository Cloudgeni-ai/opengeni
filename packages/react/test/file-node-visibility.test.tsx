import { describe, expect, test } from "bun:test";

import { FileBrowser } from "../src/components/file-browser";
import { SandboxFiles } from "../src/components/sandbox-files";
import {
  filePathVisibility,
  visibleFileTree,
  type FileNodeVisibilityPredicate,
} from "../src/file-node-visibility";
import type { FileTreeNode, UseSandboxFilesResult } from "../src/hooks/use-sandbox-files";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const rootDotfileFilter: FileNodeVisibilityPredicate = (node, context) =>
  !(context.depth === 0 && node.name.startsWith("."));

const tree: FileTreeNode[] = [
  {
    path: ".github",
    name: ".github",
    kind: "dir",
    children: [{ path: ".github/workflows/ci.yml", name: "ci.yml", kind: "file" }],
  },
  { path: ".env", name: ".env", kind: "file" },
  {
    path: "src",
    name: "src",
    kind: "dir",
    children: [{ path: "src/.env", name: ".env", kind: "file" }],
  },
  { path: "README.md", name: "README.md", kind: "file" },
];

function filesResult(): UseSandboxFilesResult {
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
  };
}

describe("file node visibility", () => {
  test("keeps the default tree byte-for-byte and filters hidden parent subtrees", () => {
    expect(visibleFileTree(tree)).toBe(tree);
    expect(visibleFileTree(tree, rootDotfileFilter)).toEqual([
      {
        path: "src",
        name: "src",
        kind: "dir",
        children: [{ path: "src/.env", name: ".env", kind: "file" }],
      },
      { path: "README.md", name: "README.md", kind: "file" },
    ]);
  });

  test("classifies hidden descendants without treating unknown lazy paths as denied", () => {
    expect(filePathVisibility(tree, ".github/workflows/ci.yml", rootDotfileFilter)).toBe("hidden");
    expect(filePathVisibility(tree, "src/.env", rootDotfileFilter)).toBe("visible");
    expect(filePathVisibility(tree, "src/not-loaded/deep.ts", rootDotfileFilter)).toBe("unknown");
  });

  test("does not render or reveal a hidden selection", async () => {
    const rendered = await renderComponent(
      <FileBrowser
        result={filesResult()}
        isNodeVisible={rootDotfileFilter}
        selectedPath=".github/workflows/ci.yml"
        revealPath=".github/workflows/ci.yml"
        revealPathRequestId={1}
        editable={false}
      />,
    );
    await flush();

    expect(rendered.container.textContent).not.toContain(".github");
    expect(rendered.container.textContent).not.toContain("ci.yml");
    expect(rendered.container.textContent).toContain("src");
    expect(rendered.container.textContent).toContain("README.md");
    expect(
      rendered.container.querySelector('[role="tree"]')?.getAttribute("aria-activedescendant"),
    ).toBeNull();
    await rendered.unmount();
  });

  test("does not read a hidden initial selection", async () => {
    const reads: string[] = [];
    const files = filesResult();
    files.readFile = async (path) => {
      reads.push(path);
      return {
        path,
        encoding: "utf8",
        content: "secret",
        sizeBytes: 6,
        truncated: false,
        isBinary: false,
        revision: 0,
      };
    };
    const rendered = await renderComponent(
      <SandboxFiles
        files={files}
        initialSelectedPath=".env"
        isNodeVisible={rootDotfileFilter}
        editable={false}
      />,
    );
    await flush();

    expect(reads).toEqual([]);
    expect(rendered.container.querySelector("[data-opengeni-selected-file]")?.textContent).toBe(
      "No file selected",
    );
    await rendered.unmount();
  });

  test("defers a filtered initial read until the root tree is available", async () => {
    const reads: string[] = [];
    const loadingFiles = filesResult();
    loadingFiles.tree = [];
    loadingFiles.loading = true;
    loadingFiles.readFile = async (path) => {
      reads.push(path);
      return {
        path,
        encoding: "utf8",
        content: "secret",
        sizeBytes: 6,
        truncated: false,
        isBinary: false,
        revision: 0,
      };
    };
    const rendered = await renderComponent(
      <SandboxFiles
        files={loadingFiles}
        initialSelectedPath=".env"
        isNodeVisible={rootDotfileFilter}
        editable={false}
      />,
    );
    await flush();
    expect(reads).toEqual([]);

    const loadedFiles = filesResult();
    loadedFiles.readFile = loadingFiles.readFile;
    await rendered.rerender(
      <SandboxFiles
        files={loadedFiles}
        initialSelectedPath=".env"
        isNodeVisible={rootDotfileFilter}
        editable={false}
      />,
    );
    await flush();

    expect(reads).toEqual([]);
    expect(rendered.container.querySelector("[data-opengeni-selected-file]")?.textContent).toBe(
      "No file selected",
    );
    await rendered.unmount();
  });
});
