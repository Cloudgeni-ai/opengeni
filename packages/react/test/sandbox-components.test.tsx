/* ----------------------------------------------------------------------------
   Phase 5 component tests: the terminal/tree/diff/desktop components render
   against mocked SDK data; the desktop consent gate + unavailable + viewer-cap
   states render; SSR lazy-import (xterm/noVNC) does not crash on the server.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import type { DesktopRfbFactory, DesktopRfbLike } from "@opengeni/sdk";
import { useState } from "react";
import { actRun, registerDom, renderComponent, flush } from "./render-hook";
import { fakeCapabilities, fakeFileDiff, fakeHeadlessCapabilities } from "./sandbox-fixtures";
import { desktopPrimaryShortcut, DesktopViewer } from "../src/components/desktop-viewer";
import { DiffView } from "../src/components/diff-view";
import { PierreDiff } from "../src/components/pierre-diff";
import { FileBrowser } from "../src/components/file-browser";
import { SandboxFiles } from "../src/components/sandbox-files";
import type { UseSandboxFilesResult } from "../src/hooks/use-sandbox-files";
import { CapturedFileUnavailableError } from "../src/hooks/use-sandbox-files";
import type { UseSandboxGitResult } from "../src/hooks/use-sandbox-git";
import { CREDIT_EXHAUSTION_MESSAGE } from "../src/lib/format";

registerDom();

function filesResult(overrides: Partial<UseSandboxFilesResult> = {}): UseSandboxFilesResult {
  return {
    tree: [
      {
        path: "src",
        name: "src",
        kind: "dir",
        children: [{ path: "src/app.ts", name: "app.ts", kind: "file", status: "modified" }],
      },
      { path: "README.md", name: "README.md", kind: "file" },
    ],
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

function gitResult(overrides: Partial<UseSandboxGitResult> = {}): UseSandboxGitResult {
  return {
    diff: [],
    branch: "main",
    isRepo: true,
    ahead: 0,
    behind: 0,
    repoCount: 1,
    repoRoots: [""],
    refresh: async () => {},
    source: "capture",
    capturedAt: "2026-07-16T12:00:00.000Z",
    loading: false,
    error: null,
    ...overrides,
  };
}

function selectedFile(container: HTMLElement): string | null {
  return container.querySelector("[data-opengeni-selected-file]")?.textContent ?? null;
}

function fileButton(container: HTMLElement, name: string): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>("[role=treeitem] button"),
  ).find((candidate) => candidate.textContent?.includes(name));
  if (!button) {
    throw new Error(`Missing file button: ${name}`);
  }
  return button;
}

function treeItem(container: HTMLElement, name: string): HTMLElement {
  const item = Array.from(container.querySelectorAll<HTMLElement>("[role=treeitem]")).find(
    (candidate) => candidate.querySelector("button")?.textContent?.trim() === name,
  );
  if (!item) {
    throw new Error(`Missing tree item: ${name}`);
  }
  return item;
}

const DEEP_FILE = "/repo/src/features/app.ts";

function LazyRevealHarness({
  requestId,
  expandCalls,
}: {
  requestId: number;
  expandCalls: string[];
}) {
  const [phase, setPhase] = useState(0);
  const tree: UseSandboxFilesResult["tree"] = [
    {
      path: "/repo",
      name: "repo",
      kind: "dir",
      children:
        phase >= 1
          ? [
              {
                path: "/repo/src",
                name: "src",
                kind: "dir",
                children:
                  phase >= 2
                    ? [
                        {
                          path: "/repo/src/features",
                          name: "features",
                          kind: "dir",
                          children:
                            phase >= 3
                              ? [
                                  {
                                    path: DEEP_FILE,
                                    name: "app.ts",
                                    kind: "file",
                                  },
                                ]
                              : undefined,
                        },
                      ]
                    : undefined,
              },
            ]
          : undefined,
    },
  ];
  return (
    <FileBrowser
      result={filesResult({
        tree,
        expand: async (path) => {
          expandCalls.push(path);
          if (path === "/repo") setPhase((current) => Math.max(current, 1));
          if (path === "/repo/src") setPhase((current) => Math.max(current, 2));
          if (path === "/repo/src/features") setPhase((current) => Math.max(current, 3));
        },
      })}
      selectedPath={DEEP_FILE}
      revealPath={DEEP_FILE}
      revealPathRequestId={requestId}
      editable={false}
    />
  );
}

describe("FileBrowser", () => {
  test("renders the tree from useSandboxFiles data", async () => {
    const r = await renderComponent(<FileBrowser result={filesResult()} />);
    await flush();
    const tree = r.container.querySelector("[data-opengeni-file-tree]");
    expect(tree).not.toBeNull();
    expect(r.container.textContent).toContain("src");
    expect(r.container.textContent).toContain("README.md");
    await r.unmount();
  });

  test("renders a fallback when the surface errored", async () => {
    const r = await renderComponent(
      <FileBrowser
        result={filesResult({ tree: [], error: new Error("boom") })}
        fallback="files off"
      />,
    );
    await flush();
    expect(r.container.textContent).toContain("files off");
    await r.unmount();
  });

  test("keeps captured files visible with an accessible retry state and no mutations", async () => {
    const r = await renderComponent(
      <FileBrowser
        result={filesResult({
          source: "capture",
          capturedAt: "2026-07-19T10:44:52.383Z",
          error: new Error("OpenGeni API 503: Workspace files are temporarily unavailable"),
        })}
      />,
    );
    await flush();

    const degraded = r.container.querySelector("[data-opengeni-files-degraded]");
    expect(degraded?.getAttribute("role")).toBe("status");
    expect(degraded?.textContent).toContain("Showing the latest captured revision");
    expect(r.container.textContent).toContain("README.md");
    expect(r.container.querySelector('button[aria-label="New file"]')).toBeNull();
    expect(r.container.querySelector('button[aria-label="Delete"]')).toBeNull();
    await r.unmount();
  });

  test("a guarded reveal lazily expands every authoritative ancestor and shows the exact file", async () => {
    const expandCalls: string[] = [];
    const scrolled: Element[] = [];
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function () {
      scrolled.push(this);
    };
    try {
      const r = await renderComponent(
        <LazyRevealHarness requestId={1} expandCalls={expandCalls} />,
      );
      try {
        await flush(20);

        expect(expandCalls).toEqual(["/repo", "/repo/src", "/repo/src/features"]);
        expect(treeItem(r.container, "repo").getAttribute("aria-expanded")).toBe("true");
        expect(treeItem(r.container, "src").getAttribute("aria-expanded")).toBe("true");
        expect(treeItem(r.container, "features").getAttribute("aria-expanded")).toBe("true");
        expect(treeItem(r.container, "app.ts").getAttribute("aria-selected")).toBe("true");
        expect(scrolled.some((element) => element.textContent?.includes("app.ts"))).toBe(true);
      } finally {
        await r.unmount();
      }
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  test("reveal identity reopens a collapsed path while the same request leaves user state alone", async () => {
    const expandCalls: string[] = [];
    const r = await renderComponent(<LazyRevealHarness requestId={1} expandCalls={expandCalls} />);
    await flush(20);
    await actRun(() => fileButton(r.container, "repo").click());
    expect(treeItem(r.container, "repo").getAttribute("aria-expanded")).toBe("false");

    await r.rerender(<LazyRevealHarness requestId={1} expandCalls={expandCalls} />);
    await flush();
    expect(treeItem(r.container, "repo").getAttribute("aria-expanded")).toBe("false");

    await r.rerender(<LazyRevealHarness requestId={2} expandCalls={expandCalls} />);
    await flush();
    expect(treeItem(r.container, "repo").getAttribute("aria-expanded")).toBe("true");
    expect(treeItem(r.container, "app.ts").getAttribute("aria-selected")).toBe("true");
    expect(expandCalls).toEqual(["/repo", "/repo/src", "/repo/src/features"]);
    await r.unmount();
  });

  test("reveal follows target-owned backslash boundaries without rewriting the path", async () => {
    const expandCalls: string[] = [];
    const target = "C:\\repo\\src\\app.ts";
    const r = await renderComponent(
      <FileBrowser
        result={filesResult({
          tree: [
            {
              path: "C:\\repo",
              name: "repo",
              kind: "dir",
              children: [
                {
                  path: "C:\\repo\\src",
                  name: "src",
                  kind: "dir",
                  children: undefined,
                },
              ],
            },
          ],
          expand: async (path) => {
            expandCalls.push(path);
          },
        })}
        selectedPath={target}
        revealPath={target}
        revealPathRequestId={1}
        editable={false}
      />,
    );
    await flush();

    expect(expandCalls).toEqual(["C:\\repo\\src"]);
    expect(treeItem(r.container, "repo").getAttribute("aria-expanded")).toBe("true");
    expect(treeItem(r.container, "src").getAttribute("aria-expanded")).toBe("true");
    await r.unmount();
  });

  test("an empty tree shows the empty state (no crash)", async () => {
    const r = await renderComponent(
      <FileBrowser result={filesResult({ tree: [] })} emptyState="nothing here" />,
    );
    await flush();
    expect(r.container.textContent).toContain("nothing here");
    await r.unmount();
  });

  test("delete uses a non-blocking accessible confirmation and can be cancelled", async () => {
    const deleted: string[] = [];
    const r = await renderComponent(
      <FileBrowser
        result={filesResult({
          deleteEntry: async (path) => {
            deleted.push(path);
          },
        })}
      />,
    );
    await flush();

    const openDelete = async () => {
      const file = fileButton(r.container, "README.md");
      const more = file.querySelector<HTMLElement>('[aria-label="More actions"]');
      expect(more).not.toBeNull();
      await actRun(() => more!.click());
      const action = Array.from(r.container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Delete",
      );
      expect(action).toBeDefined();
      await actRun(() => action!.click());
      await flush();
    };

    await openDelete();
    expect(document.body.textContent).toContain("Delete file?");
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("README.md will be permanently removed.");
    const cancel = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Cancel",
    );
    await actRun(() => cancel!.click());
    await flush();
    expect(deleted).toEqual([]);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();

    await openDelete();
    const confirm = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Delete permanently",
    );
    await actRun(() => confirm!.click());
    await flush();
    expect(deleted).toEqual(["README.md"]);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    await r.unmount();
  });
});

describe("SandboxFiles credit-drain overlay", () => {
  test("a capabilities error beats the resting wake gate", async () => {
    let retryCalls = 0;
    const r = await renderComponent(
      <SandboxFiles
        files={filesResult({ tree: [] })}
        git={gitResult()}
        workspaceResting
        capabilitiesError={new Error(CREDIT_EXHAUSTION_MESSAGE)}
        onRetry={() => {
          retryCalls += 1;
        }}
        onWakeWorkspace={() => {
          throw new Error("wake must not run while credit-drained");
        }}
      />,
    );
    await flush();
    expect(r.container.querySelector("[data-opengeni-sandbox-unavailable]")).not.toBeNull();
    expect(r.container.textContent).toContain("Sandbox unavailable");
    expect(r.container.textContent).toContain(CREDIT_EXHAUSTION_MESSAGE);
    expect(r.container.textContent).not.toContain("Workspace is resting");
    expect(r.container.textContent).not.toContain("Open live workspace");
    const retry = Array.from(r.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(retry).toBeDefined();
    await actRun(() => retry!.click());
    expect(retryCalls).toBe(1);
    await r.unmount();
  });

  test("a capabilities error also beats an unavailable file-system empty state", async () => {
    const r = await renderComponent(
      <SandboxFiles
        files={filesResult({ tree: [] })}
        git={gitResult()}
        fileSystemAvailable={false}
        capabilitiesError={new Error(CREDIT_EXHAUSTION_MESSAGE)}
      />,
    );
    await flush();
    expect(r.container.querySelector("[data-opengeni-sandbox-unavailable]")).not.toBeNull();
    expect(r.container.textContent).toContain(CREDIT_EXHAUSTION_MESSAGE);
    expect(r.container.textContent).not.toContain("Files unavailable");
    await r.unmount();
  });
});

describe("SandboxFiles guarded-file routing", () => {
  test("restores and reports the selected file", async () => {
    const selected: Array<string | null> = [];
    const r = await renderComponent(
      <SandboxFiles
        files={filesResult()}
        git={gitResult()}
        initialSelectedPath="src/app.ts"
        onSelectedPathChange={(path) => selected.push(path)}
      />,
    );
    await flush();
    expect(selectedFile(r.container)).toContain("src/app.ts");

    await actRun(() => fileButton(r.container, "README.md").click());
    expect(selected).toEqual(["README.md"]);
    await r.unmount();
  });

  test("capture-only untouched files expose an explicit live-open action", async () => {
    let wakeCalls = 0;
    const files = filesResult({
      source: "capture",
      readFile: async (path) => {
        throw new CapturedFileUnavailableError(path, "not-captured");
      },
    });
    const r = await renderComponent(
      <SandboxFiles
        files={files}
        git={gitResult()}
        liveWorkspaceReady={false}
        onWakeWorkspace={() => {
          wakeCalls += 1;
        }}
      />,
    );
    await flush();
    await actRun(() => fileButton(r.container, "README.md").click());
    await flush();
    expect(r.container.textContent).toContain("On machine");
    expect(r.container.textContent).toContain("Open live file");
    const openLive = Array.from(r.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Open live file"),
    );
    expect(openLive).toBeDefined();
    expect(openLive?.classList.contains("bg-og-accent-deep")).toBe(true);
    expect(openLive?.classList.contains("text-og-accent-fg")).toBe(true);
    await actRun(() => openLive!.click());
    expect(wakeCalls).toBe(1);
    expect(r.container.textContent).toContain("Waking workspace");
    await r.unmount();
  });

  test("an already-warm capture fallback retries the live list instead of issuing a no-op wake", async () => {
    let refreshCalls = 0;
    let wakeCalls = 0;
    const files = filesResult({
      source: "capture",
      error: new Error("OpenGeni API 503: Workspace files are temporarily unavailable"),
      readFile: async (path) => {
        throw new CapturedFileUnavailableError(path, "not-captured");
      },
      refresh: async () => {
        refreshCalls += 1;
      },
    });
    const r = await renderComponent(
      <SandboxFiles
        files={files}
        git={gitResult()}
        liveWorkspaceReady
        onWakeWorkspace={() => {
          wakeCalls += 1;
        }}
      />,
    );
    await flush();
    await actRun(() => fileButton(r.container, "README.md").click());
    await flush();

    const retry = Array.from(r.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Retry live file"),
    );
    expect(retry).toBeDefined();
    await actRun(() => retry!.click());
    expect(refreshCalls).toBe(1);
    expect(wakeCalls).toBe(0);
    await r.unmount();
  });

  test("the header describes a multi-repo workspace without inventing one branch", async () => {
    const r = await renderComponent(
      <SandboxFiles
        files={filesResult()}
        git={gitResult({ branch: null, repoCount: 2, repoRoots: ["api", "web"] })}
      />,
    );
    await flush();
    expect(r.container.textContent).toContain("2 repositories");
    expect(r.container.textContent).not.toContain("(detached)");
    await r.unmount();
  });

  test("manual navigation consumes a pending cold request and wins after warm-up", async () => {
    const files = filesResult();
    const git = gitResult();
    const r = await renderComponent(
      <SandboxFiles
        files={files}
        git={git}
        requestedPath="src/app.ts"
        requestedPathRequestId={1}
        requestedPathReady={false}
      />,
    );
    await flush();

    await actRun(() => fileButton(r.container, "README.md").click());
    expect(selectedFile(r.container)).toBe("README.md");

    await r.rerender(
      <SandboxFiles
        files={files}
        git={git}
        requestedPath="src/app.ts"
        requestedPathRequestId={1}
        requestedPathReady={true}
      />,
    );
    await flush();
    expect(selectedFile(r.container)).toBe("README.md");
    await r.unmount();
  });

  test("a new request identity deliberately reopens the same guarded path", async () => {
    const files = filesResult();
    const git = gitResult();
    const r = await renderComponent(
      <SandboxFiles files={files} git={git} requestedPath="README.md" requestedPathRequestId={1} />,
    );
    await flush();
    expect(selectedFile(r.container)).toBe("README.md");

    await actRun(() => fileButton(r.container, "src").click());
    await flush();
    await actRun(() => fileButton(r.container, "app.ts").click());
    expect(selectedFile(r.container)).toBe("src/app.ts");

    await r.rerender(
      <SandboxFiles files={files} git={git} requestedPath="README.md" requestedPathRequestId={2} />,
    );
    await flush();
    expect(selectedFile(r.container)).toBe("README.md");
    await r.unmount();
  });

  test("a requested line opens the file and highlights that row", async () => {
    const files = filesResult({
      readFile: async (path) => ({
        path,
        encoding: "utf8",
        content: "alpha\nbeta\ngamma\ndelta\n",
        sizeBytes: 24,
        truncated: false,
        isBinary: false,
        revision: 0,
      }),
    });
    const r = await renderComponent(
      <SandboxFiles
        files={files}
        git={gitResult()}
        requestedPath="README.md"
        requestedLine={3}
        requestedPathRequestId={1}
      />,
    );
    await flush();
    expect(selectedFile(r.container)).toBe("README.md:3");
    const focused = r.container.querySelector("[data-opengeni-focus-line]");
    expect(focused?.getAttribute("data-opengeni-file-line")).toBe("3");
    expect(focused?.textContent).toContain("gamma");
    await r.unmount();
  });

  test("an out-of-range requested line remains a truthful visible state", async () => {
    const files = filesResult({
      readFile: async (path) => ({
        path,
        encoding: "utf8",
        content: "alpha\nbeta\n",
        sizeBytes: 11,
        truncated: false,
        isBinary: false,
        revision: 0,
      }),
    });
    const r = await renderComponent(
      <SandboxFiles
        files={files}
        git={gitResult()}
        requestedPath="README.md"
        requestedLine={99}
        requestedPathRequestId={1}
      />,
    );
    await flush();
    const status = r.container.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Line 99 is past the end of this file");
    expect(r.container.querySelector("[data-opengeni-focus-line]")).toBeNull();
    await r.unmount();
  });

  test("a requested path read failure is explicit instead of an empty viewer", async () => {
    const path = "/projects/example/missing.ts";
    const r = await renderComponent(
      <SandboxFiles
        files={filesResult({
          readFile: async () => {
            throw new Error("file is unavailable");
          },
        })}
        git={gitResult()}
        requestedPath={path}
        requestedPathRequestId={1}
      />,
    );
    await flush();
    const alert = r.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(`Could not open ${path}: file is unavailable`);
    await r.unmount();
  });

  test("a repeated request retries the same file after a read failure", async () => {
    let reads = 0;
    const files = filesResult({
      readFile: async (path) => {
        reads += 1;
        if (reads === 1) throw new Error("temporary read failure");
        return {
          path,
          encoding: "utf8",
          content: "recovered\n",
          sizeBytes: 10,
          truncated: false,
          isBinary: false,
          revision: 0,
        };
      },
    });
    const git = gitResult();
    const r = await renderComponent(
      <SandboxFiles
        files={files}
        git={git}
        requestedPath="README.md"
        requestedPathRequestId={1}
        usePierre={false}
      />,
    );
    await flush();
    expect(r.container.querySelector('[role="alert"]')?.textContent).toContain(
      "temporary read failure",
    );

    await r.rerender(
      <SandboxFiles
        files={files}
        git={git}
        requestedPath="README.md"
        requestedPathRequestId={2}
        usePierre={false}
      />,
    );
    await flush();
    expect(reads).toBe(2);
    expect(r.container.textContent).toContain("recovered");
    expect(r.container.querySelector('[role="alert"]')).toBeNull();
    await r.unmount();
  });

  test("a new path-only request for the same file clears an earlier line focus", async () => {
    const files = filesResult({
      readFile: async (path) => ({
        path,
        encoding: "utf8",
        content: "alpha\nbeta\ngamma\ndelta\n",
        sizeBytes: 24,
        truncated: false,
        isBinary: false,
        revision: 0,
      }),
    });
    const git = gitResult();
    const r = await renderComponent(
      <SandboxFiles
        files={files}
        git={git}
        requestedPath="README.md"
        requestedLine={3}
        requestedPathRequestId={1}
      />,
    );
    await flush();
    expect(selectedFile(r.container)).toBe("README.md:3");
    expect(r.container.querySelector("[data-opengeni-focus-line]")).not.toBeNull();
    const viewer = r.container.querySelector<HTMLElement>("[data-opengeni-file-viewer-scroll]")!;
    viewer.scrollTop = 77;

    await r.rerender(
      <SandboxFiles files={files} git={git} requestedPath="README.md" requestedPathRequestId={2} />,
    );
    await flush();
    expect(selectedFile(r.container)).toBe("README.md");
    expect(r.container.querySelector("[data-opengeni-focus-line]")).toBeNull();
    expect(viewer.scrollTop).toBe(0);
    await r.unmount();
  });
});

describe("DiffView (@deprecated alias)", () => {
  // DiffView is now a thin alias over the ONE renderer, PierreDiff — the
  // hand-rolled hunk renderer was removed (D3). It delegates to Pierre for a
  // non-empty diff and still shows the empty/no-repo states directly.
  test("delegates a non-empty diff to the Pierre renderer", async () => {
    const r = await renderComponent(<DiffView diff={[fakeFileDiff()]} />);
    await flush();
    expect(r.container.querySelector("[data-opengeni-pierre-diff]")).not.toBeNull();
    // The removed hand-rolled renderer's marker is gone.
    expect(r.container.querySelector("[data-opengeni-diff]")).toBeNull();
    await r.unmount();
  });

  test("delegates a split-layout diff to the Pierre renderer", async () => {
    const r = await renderComponent(<DiffView diff={[fakeFileDiff()]} layout="split" />);
    await flush();
    expect(r.container.querySelector("[data-opengeni-pierre-diff]")).not.toBeNull();
    await r.unmount();
  });

  test("distinguishes 'no changes' (repo) from 'no repository' (no repo)", async () => {
    const repo = await renderComponent(<DiffView diff={[]} isRepo={true} />);
    await flush();
    expect(repo.container.textContent).toContain("No changes");
    await repo.unmount();

    const noRepo = await renderComponent(<DiffView diff={[]} isRepo={false} />);
    await flush();
    expect(noRepo.container.textContent).toContain("No repository mounted");
    await noRepo.unmount();
  });
});

describe("PierreDiff (the one renderer)", () => {
  // The plain degrade is the deterministic surface for a host without
  // `@pierre/diffs` (or opting out) — a text patch, NOT a second hunk renderer.
  test("plain degrade renders the reconstructed patch text", async () => {
    const r = await renderComponent(<PierreDiff diff={[fakeFileDiff()]} plain />);
    await flush();
    expect(r.container.textContent).toContain("src/app.ts");
    expect(r.container.textContent).toContain("const b = 3;");
    expect(
      r.container.querySelector<HTMLElement>('[role="region"][aria-label="Diff for src/app.ts"]')
        ?.tabIndex,
    ).toBe(0);
    await r.unmount();
  });

  test("plain degrade with an empty diff says 'No changes' (never crashes)", async () => {
    const r = await renderComponent(<PierreDiff diff={[]} plain />);
    await flush();
    expect(r.container.textContent).toContain("No changes");
    await r.unmount();
  });
});

describe("DesktopViewer", () => {
  test("maps the host primary modifier onto the remote RFB platform", () => {
    const event = {
      altKey: false,
      code: "KeyA",
      ctrlKey: false,
      key: "a",
      metaKey: true,
      shiftKey: false,
    };
    expect(desktopPrimaryShortcut(event, "mac", "linux")).toEqual([
      { keysym: 0xffe3, code: "ControlLeft", down: true },
      { keysym: 97, code: "KeyA", down: true },
      { keysym: 97, code: "KeyA", down: false },
      { keysym: 0xffe3, code: "ControlLeft", down: false },
    ]);
    expect(desktopPrimaryShortcut(event, "mac", "macos")).toEqual([
      { keysym: 0xffeb, code: "MetaLeft", down: true },
      { keysym: 97, code: "KeyA", down: true },
      { keysym: 97, code: "KeyA", down: false },
      { keysym: 0xffeb, code: "MetaLeft", down: false },
    ]);
    expect(desktopPrimaryShortcut({ ...event, key: "v" }, "mac", "linux")).toBe("clipboard");
  });

  // A fake RFB that records construction + reports its viewOnly + scaling setting.
  function fakeRfb(): {
    factory: DesktopRfbFactory;
    calls: { url: string; viewOnly: boolean; scaleViewport: boolean; clipViewport: boolean }[];
  } {
    const calls: {
      url: string;
      viewOnly: boolean;
      scaleViewport: boolean;
      clipViewport: boolean;
    }[] = [];
    const factory: DesktopRfbFactory = (_target, url) => {
      const rfb: DesktopRfbLike = {
        viewOnly: false,
        scaleViewport: false,
        clipViewport: false,
        addEventListener: () => {},
        removeEventListener: () => {},
        disconnect: () => {},
      };
      // Record after the hook sets viewOnly/scaling on the next tick.
      queueMicrotask(() =>
        calls.push({
          url,
          viewOnly: rfb.viewOnly,
          scaleViewport: rfb.scaleViewport,
          clipViewport: rfb.clipViewport,
        }),
      );
      return rfb;
    };
    return { factory, calls };
  }

  test("a headless desktop cell renders the reason-aware unavailable notice", async () => {
    const cap = fakeHeadlessCapabilities().DesktopStream; // reason: backend_unsupported
    const r = await renderComponent(<DesktopViewer capability={cap} />);
    await flush();
    expect(r.container.textContent).toContain("Desktop unavailable");
    expect(r.container.textContent).toContain("cannot stream a desktop");
    await r.unmount();
  });

  test("an un-acknowledged desktop opens automatically without a consent gate", async () => {
    let activationCalls = 0;
    let acknowledgmentCalls = 0;
    const { factory } = fakeRfb();
    const cap = fakeCapabilities({
      DesktopStream: {
        ...fakeCapabilities().DesktopStream,
        requiresAcknowledgment: true,
        acknowledged: false,
      },
    }).DesktopStream;
    const r = await renderComponent(
      <DesktopViewer
        capability={cap}
        onActivate={() => {
          activationCalls += 1;
        }}
        onAcknowledge={async () => {
          acknowledgmentCalls += 1;
        }}
        rfbFactory={factory}
      />,
    );
    await flush();
    expect(activationCalls).toBe(1);
    expect(acknowledgmentCalls).toBe(1);
    expect(r.container.textContent).toContain("Opening the desktop");
    expect(r.container.textContent).not.toContain("Watch the live desktop");
    expect(r.container.textContent).not.toContain("un-redacted");
    expect(r.container.querySelector("button")).toBeNull();
    await r.rerender(
      <DesktopViewer
        capability={cap}
        onActivate={() => {
          activationCalls += 1;
        }}
        onAcknowledge={async () => {
          acknowledgmentCalls += 1;
        }}
      />,
    );
    await flush();
    expect(activationCalls).toBe(1);
    expect(acknowledgmentCalls).toBe(1);
    await r.unmount();
  });

  test("the viewer-cap (429) renders a friendly notice", async () => {
    const cap = fakeCapabilities().DesktopStream;
    const r = await renderComponent(<DesktopViewer capability={cap} viewerCapReached />);
    await flush();
    expect(r.container.textContent).toContain("Too many viewers");
    await r.unmount();
  });

  test("an acknowledged warm desktop connects read-only via the RFB factory", async () => {
    const { factory, calls } = fakeRfb();
    const cap = fakeCapabilities().DesktopStream; // acknowledged:true, url present, vnc-ws
    const r = await renderComponent(<DesktopViewer capability={cap} rfbFactory={factory} />);
    await flush(5);
    expect(calls.length).toBeGreaterThan(0);
    // read-only is enforced (mode === "read-only" forces viewOnly).
    expect(calls[0]?.viewOnly).toBe(true);
    // The socket url was normalized to wss + websockify path.
    expect(calls[0]?.url.startsWith("wss://")).toBe(true);
    expect(calls[0]?.url).toContain("/websockify");
    // Fit-to-panel: the 1280x800 framebuffer SCALES to the container and is
    // never 1:1-clipped (the "zoomed in" regression).
    expect(calls[0]?.scaleViewport).toBe(true);
    expect(calls[0]?.clipViewport).toBe(false);
    await r.unmount();
  });

  // A fake RFB that keeps every constructed instance live so the test can read
  // their `viewOnly` AFTER an in-place update (the live take-control path).
  function trackingRfb(): { factory: DesktopRfbFactory; instances: DesktopRfbLike[] } {
    const instances: DesktopRfbLike[] = [];
    const factory: DesktopRfbFactory = () => {
      const rfb: DesktopRfbLike = {
        viewOnly: false,
        scaleViewport: false,
        clipViewport: false,
        addEventListener: () => {},
        removeEventListener: () => {},
        disconnect: () => {},
      };
      instances.push(rfb);
      return rfb;
    };
    return { factory, instances };
  }

  test("taking control flips viewOnly in place — it does NOT reconnect the socket", async () => {
    const { factory, instances } = trackingRfb();
    // An interactive-mode warm cell so take-control is permitted.
    const cap = { ...fakeCapabilities().DesktopStream, mode: "interactive" as const };

    // Watching (read-only): connects once, viewOnly true.
    const r = await renderComponent(
      <DesktopViewer capability={cap} interactive={false} rfbFactory={factory} />,
    );
    await flush(5);
    expect(instances.length).toBe(1);
    expect(instances[0]?.viewOnly).toBe(true);

    // TAKE CONTROL: the same cell, only `interactive` flips true. This must NOT
    // tear down + rebuild the RFB (the old reconnect-loop / refresh bug) — the
    // existing socket's viewOnly is flipped live to false.
    await r.rerender(<DesktopViewer capability={cap} interactive={true} rfbFactory={factory} />);
    await flush(5);
    expect(instances.length).toBe(1); // still exactly one socket — no reconnect.
    expect(instances[0]?.viewOnly).toBe(false); // input enabled in place.

    // RETURN CONTROL: flips back, still no reconnect.
    await r.rerender(<DesktopViewer capability={cap} interactive={false} rfbFactory={factory} />);
    await flush(5);
    expect(instances.length).toBe(1);
    expect(instances[0]?.viewOnly).toBe(true);
    await r.unmount();
  });

  test("desktop paste is accepted only by an explicit host clipboard authority", async () => {
    const pasted: string[] = [];
    let connect: (() => void) | undefined;
    const factory: DesktopRfbFactory = () => ({
      viewOnly: false,
      scaleViewport: false,
      clipViewport: false,
      addEventListener: (type, cb) => {
        if (type === "connect") connect = cb;
      },
      removeEventListener: () => {},
      disconnect: () => {},
    });
    const cap = { ...fakeCapabilities().DesktopStream, mode: "interactive" as const };
    const r = await renderComponent(
      <DesktopViewer
        capability={cap}
        interactive
        rfbFactory={factory}
        onPasteText={(text) => {
          pasted.push(text);
          return true;
        }}
      />,
    );
    await flush(5);
    await actRun(() => connect?.());
    await flush();

    const root = r.container.querySelector<HTMLElement>("[data-opengeni-desktop]");
    expect(root).not.toBeNull();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData: (type: string) => (type === "text/plain" ? "exact paste" : ""),
        types: ["text/plain"],
      },
    });
    await actRun(() => root?.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(pasted).toEqual(["exact paste"]);
    await r.unmount();
  });

  test("a Mac primary shortcut is sent once as target Control over the live RFB", async () => {
    const keys: Array<{ keysym: number; code: string; down?: boolean }> = [];
    let connect: (() => void) | undefined;
    const priorPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    const factory: DesktopRfbFactory = () => ({
      viewOnly: false,
      scaleViewport: false,
      clipViewport: false,
      addEventListener: (type, cb) => {
        if (type === "connect") connect = cb;
      },
      removeEventListener: () => {},
      sendKey: (keysym, code, down) =>
        keys.push({ keysym, code, ...(down !== undefined ? { down } : {}) }),
      disconnect: () => {},
    });
    const cap = { ...fakeCapabilities().DesktopStream, mode: "interactive" as const };
    const r = await renderComponent(
      <DesktopViewer capability={cap} interactive targetPlatform="linux" rfbFactory={factory} />,
    );
    try {
      await flush(5);
      await actRun(() => connect?.());
      await flush();
      const root = r.container.querySelector<HTMLElement>("[data-opengeni-desktop]")!;
      await actRun(() =>
        root.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            code: "MetaLeft",
            key: "Meta",
            metaKey: true,
          }),
        ),
      );
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyA",
        key: "a",
        metaKey: true,
      });
      await actRun(() => root.dispatchEvent(event));
      await actRun(() =>
        root.dispatchEvent(
          new KeyboardEvent("keyup", {
            bubbles: true,
            cancelable: true,
            code: "MetaLeft",
            key: "Meta",
          }),
        ),
      );
      expect(event.defaultPrevented).toBe(true);
      expect(keys).toEqual([
        { keysym: 0xffe3, code: "ControlLeft", down: true },
        { keysym: 97, code: "KeyA", down: true },
        { keysym: 97, code: "KeyA", down: false },
        { keysym: 0xffe3, code: "ControlLeft", down: false },
      ]);
    } finally {
      if (priorPlatform) Object.defineProperty(navigator, "platform", priorPlatform);
      else Reflect.deleteProperty(navigator, "platform");
      await r.unmount();
    }
  });

  test("a benign capability refresh (same url/token) does not reconnect the socket", async () => {
    const { factory, instances } = trackingRfb();
    const base = fakeCapabilities().DesktopStream;
    const r = await renderComponent(<DesktopViewer capability={base} rfbFactory={factory} />);
    await flush(5);
    expect(instances.length).toBe(1);

    // A re-negotiation re-mints the cell object (new identity) but the SAME live
    // url + token. The connect effect keys on url/token, so it must not churn.
    const refreshed = { ...base, expiresAt: new Date(Date.now() + 900_000).toISOString() };
    await r.rerender(<DesktopViewer capability={refreshed} rfbFactory={factory} />);
    await flush(5);
    expect(instances.length).toBe(1); // survived the renegotiation — no reconnect.
    await r.unmount();
  });

  test("rotating the direct-RFB bearer protocol reconnects exactly once", async () => {
    const { factory, instances } = trackingRfb();
    const cap = { ...fakeCapabilities().DesktopStream, mode: "interactive" as const };
    const first = ["opengeni.rfb.v1", "opengeni.auth.first"];
    const r = await renderComponent(
      <DesktopViewer
        capability={cap}
        interactive
        webSocketProtocols={first}
        rfbFactory={factory}
      />,
    );
    await flush(5);
    expect(instances.length).toBe(1);

    await r.rerender(
      <DesktopViewer
        capability={cap}
        interactive
        webSocketProtocols={["opengeni.rfb.v1", "opengeni.auth.second"]}
        rfbFactory={factory}
      />,
    );
    await flush(5);
    expect(instances.length).toBe(2);

    // A normal render can allocate a fresh array. Identical protocol values
    // must not churn the live RFB connection.
    await r.rerender(
      <DesktopViewer
        capability={cap}
        interactive
        webSocketProtocols={["opengeni.rfb.v1", "opengeni.auth.second"]}
        rfbFactory={factory}
      />,
    );
    await flush(5);
    expect(instances.length).toBe(2);
    await r.unmount();
  });
});
