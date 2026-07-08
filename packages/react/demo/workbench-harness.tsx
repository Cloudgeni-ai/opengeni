import { createRoot } from "react-dom/client";
import type { GitDiffHunk, GitDiffLine, GitFileDiff } from "@opengeni/sdk";
import { WorkbenchChanges } from "../src/components/workbench-changes";
import { FileBrowser } from "../src/components/file-browser";
import type { FileTreeNode, UseSandboxFilesResult } from "../src/hooks/use-sandbox-files";
import "./styles.css";

/* ----------------------------------------------------------------------------
   M5 workbench harness (static, fixture-driven) — the Changes tab (windowed
   Pierre diffs + file rail) and the virtualized file tree, in every state the
   review passes + the D2 real-browser windowing proof need. Driven by query
   params so Playwright can select a state:
     ?view=changes-large | changes-small | changes-guard | files-dense | files-residue
     &theme=dark|light
   -------------------------------------------------------------------------- */

function hunk(startAdd: number, addLines: number, ctx = 2): GitDiffHunk {
  const lines: GitDiffLine[] = [];
  for (let i = 0; i < ctx; i++)
    lines.push({
      type: "context",
      oldNo: startAdd + i,
      newNo: startAdd + i,
      text: `  const keep_${i} = ${i};`,
    });
  for (let i = 0; i < addLines; i++) {
    lines.push({
      type: "del",
      oldNo: startAdd + ctx + i,
      newNo: null,
      text: `  const removed_${i} = "old value ${i}";`,
    });
    lines.push({
      type: "add",
      oldNo: null,
      newNo: startAdd + ctx + i,
      text: `  const added_${i} = "new value ${i}";`,
    });
  }
  for (let i = 0; i < ctx; i++)
    lines.push({
      type: "context",
      oldNo: startAdd + ctx + addLines + i,
      newNo: startAdd + ctx + addLines + i,
      text: `  return added_${i};`,
    });
  return {
    oldStart: startAdd,
    oldLines: ctx + addLines,
    newStart: startAdd,
    newLines: ctx + addLines * 2,
    header: `@@ -${startAdd},${ctx + addLines} +${startAdd},${ctx + addLines * 2} @@`,
    lines,
  };
}

function file(
  path: string,
  add: number,
  del: number,
  hunks: GitDiffHunk[],
  overrides: Partial<GitFileDiff> = {},
): GitFileDiff {
  return {
    path,
    oldPath: null,
    status: "modified",
    isBinary: false,
    isImage: false,
    additions: add,
    deletions: del,
    truncated: false,
    hunks,
    ...overrides,
  };
}

function makeDiff(count: number): GitFileDiff[] {
  const dirs = [
    "apps/api/src",
    "apps/web/src/components",
    "packages/core/lib",
    "packages/db/migrations",
    "docs",
  ];
  return Array.from({ length: count }, (_, i) => {
    const dir = dirs[i % dirs.length];
    const size = 1 + (i % 5);
    return file(`${dir}/module-${String(i).padStart(3, "0")}.ts`, size * 2, size, [hunk(1, size)]);
  });
}

const smallDiff: GitFileDiff[] = [
  file("apps/api/src/server.ts", 6, 2, [hunk(1, 3), hunk(40, 2)]),
  file("apps/web/src/app.tsx", 4, 1, [hunk(1, 2)]),
  file("README.md", 2, 0, [hunk(1, 1)], { status: "added" }),
];

const guardDiff: GitFileDiff[] = [
  file("src/index.ts", 4, 1, [hunk(1, 2)]),
  file("assets/logo.png", 0, 0, [], { isBinary: true, isImage: true, status: "modified" }),
  file("data/fixtures.json", 0, 0, [], { truncated: true, additions: 12000, deletions: 8000 }),
];

/** A dense tree: `dirs` folders each with `filesPer` files, plus a collapsed
 *  residue node_modules — ~3k nodes total. */
function denseTree(dirs: number, filesPer: number): FileTreeNode[] {
  const roots: FileTreeNode[] = [
    { path: "node_modules", name: "node_modules", kind: "dir", truncated: true },
    { path: ".git", name: ".git", kind: "dir", truncated: true },
  ];
  for (let d = 0; d < dirs; d++) {
    const dir = `src/module-${String(d).padStart(2, "0")}`;
    const children: FileTreeNode[] = Array.from({ length: filesPer }, (_, f) => ({
      path: `${dir}/file-${String(f).padStart(3, "0")}.ts`,
      name: `file-${String(f).padStart(3, "0")}.ts`,
      kind: "file" as const,
      ...(f % 7 === 0 ? { status: "modified" as const } : {}),
    }));
    roots.push({ path: dir, name: `module-${String(d).padStart(2, "0")}`, kind: "dir", children });
  }
  return roots;
}

function filesResult(tree: FileTreeNode[], source: "live" | "capture"): UseSandboxFilesResult {
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
    source,
    capturedAt: source === "capture" ? new Date(Date.now() - 6 * 60_000).toISOString() : null,
    loading: false,
    error: null,
  };
}

const params = new URLSearchParams(window.location.search);
const view = params.get("view") ?? "changes-large";
const theme = params.get("theme") === "light" ? "light" : "dark";
const capturedAt = new Date(Date.now() - 6 * 60_000).toISOString();

function App() {
  let body: React.ReactNode;
  switch (view) {
    case "changes-small":
      body = (
        <WorkbenchChanges
          diff={smallDiff}
          source="capture"
          capturedAt={capturedAt}
          captureRevision={12}
        />
      );
      break;
    case "changes-guard":
      body = <WorkbenchChanges diff={guardDiff} source="live" capturedAt={null} />;
      break;
    case "files-dense":
      body = (
        <FileBrowser result={filesResult(denseTree(60, 50), "live")} className="min-h-0 flex-1" />
      );
      break;
    case "files-flat": {
      // 2000 files, all visible at the root — the strongest visible-list
      // virtualization proof (the whole flat set is on screen at once).
      const flat: FileTreeNode[] = Array.from({ length: 2000 }, (_, i) => ({
        path: `file-${String(i).padStart(4, "0")}.ts`,
        name: `file-${String(i).padStart(4, "0")}.ts`,
        kind: "file" as const,
      }));
      body = <FileBrowser result={filesResult(flat, "live")} className="min-h-0 flex-1" />;
      break;
    }
    case "files-residue": {
      // Pre-expanded residue view: a small tree so the residue dir + its inline
      // "open when live" row are visible without interaction.
      body = (
        <FileBrowser result={filesResult(denseTree(4, 6), "capture")} className="min-h-0 flex-1" />
      );
      break;
    }
    default:
      body = (
        <WorkbenchChanges
          diff={makeDiff(40)}
          source="capture"
          capturedAt={capturedAt}
          captureRevision={7}
        />
      );
  }
  return (
    <div
      className="og-root h-dvh bg-og-bg p-4"
      data-og-theme={theme === "light" ? "light" : undefined}
    >
      <div className="mx-auto flex h-full max-w-5xl flex-col overflow-hidden rounded-og-lg border border-og-border bg-og-surface-0">
        {body}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
