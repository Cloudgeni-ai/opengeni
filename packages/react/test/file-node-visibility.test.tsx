import { describe, expect, test } from "bun:test";

import { FileBrowser } from "../src/components/file-browser";
import { SandboxFiles } from "../src/components/sandbox-files";
import {
  filePathVisibility,
  isHiddenByDefault,
  pathMayBeHiddenByDefault,
  visibleFileTree,
  type FileNodeVisibilityPredicate,
} from "../src/file-node-visibility";
import type { FileTreeNode, UseSandboxFilesResult } from "../src/hooks/use-sandbox-files";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

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
  test("hides tool and cache folders anywhere, and the home's dot entries, by default", () => {
    const dir = (name: string): FileTreeNode => ({ path: name, name, kind: "dir" });
    const top = { depth: 0, parent: null };
    const inside = { depth: 2, parent: dir("repos") };
    for (const name of [".bun", ".cache", ".npm", "node_modules", "__pycache__"]) {
      expect(isHiddenByDefault(dir(name), top, false)).toBe(true);
      expect(isHiddenByDefault(dir(name), inside, true)).toBe(true);
    }
    expect(isHiddenByDefault(dir(".config"), top, false)).toBe(true);
    expect(isHiddenByDefault({ path: ".bashrc", name: ".bashrc", kind: "file" }, top, false)).toBe(
      true,
    );
    // The work stays: repositories and their own dotfiles.
    expect(isHiddenByDefault(dir("repos"), top, false)).toBe(false);
    expect(isHiddenByDefault(dir(".github"), inside, false)).toBe(false);
    expect(isHiddenByDefault(dir(".github"), top, true)).toBe(false);
    // A file named like a cache folder is just a file.
    expect(
      isHiddenByDefault({ path: "node_modules", name: "node_modules", kind: "file" }, top, false),
    ).toBe(false);
    expect(pathMayBeHiddenByDefault("repos/app/node_modules/x/index.js")).toBe(true);
    expect(pathMayBeHiddenByDefault(".opengeni/files/a.png")).toBe(true);
    expect(pathMayBeHiddenByDefault("repos/app/src/index.ts")).toBe(false);
  });

  test("the Files view leaves hidden and cache folders out until Show hidden files", async () => {
    localStorage.clear();
    const files = filesResult();
    files.tree = [
      { path: ".bun", name: ".bun", kind: "dir" },
      { path: ".cache", name: ".cache", kind: "dir" },
      { path: "node_modules", name: "node_modules", kind: "dir" },
      { path: "repos", name: "repos", kind: "dir" },
      { path: "notes.md", name: "notes.md", kind: "file" },
    ];
    const rendered = await renderComponent(<SandboxFiles files={files} editable={false} />);
    await flush();
    const names = () =>
      Array.from(rendered.container.querySelectorAll('[role="treeitem"]')).map((row) =>
        row.textContent?.trim(),
      );
    expect(names()).toEqual(["repos", "notes.md"]);
    const toggle = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show hidden files"]',
    )!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await actRun(() => toggle.click());
    await flush();
    expect(names()).toEqual([".bun", ".cache", "node_modules", "repos", "notes.md"]);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    // Remembered in this browser.
    expect(localStorage.getItem("og.files.show-hidden:v1")).toBe("1");
    await actRun(() => toggle.click());
    await flush();
    expect(localStorage.getItem("og.files.show-hidden:v1")).toBeNull();
    await rendered.unmount();
  });

  test("a top made only of hidden folders says so and offers to show them", async () => {
    localStorage.clear();
    const files = filesResult();
    files.tree = [
      { path: ".bun", name: ".bun", kind: "dir" },
      { path: ".npm", name: ".npm", kind: "dir" },
    ];
    const rendered = await renderComponent(<SandboxFiles files={files} editable={false} />);
    await flush();
    expect(rendered.container.textContent).toContain("Only hidden and tool folders here.");
    const show = Array.from(rendered.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Show hidden files",
    )!;
    await actRun(() => show.click());
    await flush();
    expect(rendered.container.textContent).toContain(".bun");
    await rendered.unmount();
  });

  test("a file opened on purpose inside a hidden folder shows hidden files", async () => {
    localStorage.clear();
    const files = filesResult();
    files.tree = [
      {
        path: ".opengeni",
        name: ".opengeni",
        kind: "dir",
        children: [{ path: ".opengeni/notes.md", name: "notes.md", kind: "file" }],
      },
      { path: "repos", name: "repos", kind: "dir" },
    ];
    const rendered = await renderComponent(
      <SandboxFiles files={files} editable={false} requestedPath=".opengeni/notes.md" />,
    );
    await flush();
    expect(
      rendered.container
        .querySelector('button[aria-label="Show hidden files"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(rendered.container.querySelector("[data-opengeni-selected-file]")?.textContent).toBe(
      ".opengeni/notes.md",
    );
    await rendered.unmount();
    localStorage.clear();
  });

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
